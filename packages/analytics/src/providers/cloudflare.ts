/**
 * The Cloudflare Web Analytics adapter — the one place that talks to
 * Cloudflare.
 *
 * The parser is tolerant on purpose: a schema change must read as "no data
 * plus an error", never as a thrown exception inside a dashboard widget.
 * Four things every query here gets right, because each one fails
 * silently when it is wrong:
 *
 * - **`siteTag` is not the beacon token.** The token in the beacon snippet
 *   and the site tag the reporting API filters on are different values
 *   (checked against the live API on 2026-09-20). A query with the token
 *   returns nothing at all.
 * - **`bot: 0`**, or bot traffic counts as page views.
 * - **A host filter.** One site tag routinely covers several hostnames —
 *   apex, `www`, and `*.pages.dev` preview deploys — so without one,
 *   preview traffic lands in production numbers.
 * - **The sampling signal.** `avg { sampleInterval }` is selected
 *   everywhere, because `count` is already scaled by it and a caller that
 *   does not know the factor cannot tell an exact number from an estimate.
 *
 * Field names are not guesses. Every identifier below was read out of the
 * live schema by introspection on 2026-09-20; note that Cloudflare's
 * GraphQL types are lower-case (`viewer`, `account`), so introspecting
 * `"Account"` returns null and sends you looking for a problem that is not
 * there.
 */

import { failure, type Problem } from "../i18n.js";
import { isInternalPath, normalizeHost, normalizePath, type TrailingSlash } from "../index/paths.js";
import { daysBetween, enumerateDays, UNSAMPLED_WINDOW_DAYS, type Day } from "../sync/window.js";
import type {
	DailyRow,
	DateRange,
	FetchLike,
	LabelledRow,
	Overview,
	PathDayRow,
	PathRow,
	Provider,
	ProviderCapabilities,
	Result,
	Retention,
	Site,
} from "./types.js";

export const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** Verified present on the live schema, 2026-09-20. */
export const RUM_DATASET = "rumPageloadEventsAdaptiveGroups";

/** `maxPageSize` from the live settings probe. */
const MAX_PAGE_SIZE = 10_000;

const TOP_PATHS_LIMIT = 20;
const REFERRERS_LIMIT = 20;
const COUNTRIES_LIMIT = 50;

/** The admin's pages as a `LIKE` pattern; see `isInternalPath`. */
const INTERNAL_PATHS = "/_emdash/%";

export const CLOUDFLARE_CAPABILITIES: ProviderCapabilities = {
	batchPaths: "filter",
	// Not an API cap: 10 000 paths were accepted in one request. This is a
	// self-imposed figure that keeps paths x days clear of `maxPageSize`
	// and the per-tick write budget within reach.
	maxPathsPerQuery: 100,
	meteredReads: false,
	defaultInterval: "*/15 * * * *",
	// No uniques. Cloudflare Web Analytics does not measure them, and
	// inventing one from visits would be a lie with a number attached.
	metrics: ["pageviews", "visits"],
	breakdowns: ["referrers", "countries"],
	exactWindowDays: UNSAMPLED_WINDOW_DAYS,
	reportsSampling: true,
};

export interface CloudflareConfig {
	apiToken: string;
	accountId: string;
	siteTag: string;
	/** Hosts to filter on. Empty means "do not filter", which counts previews. */
	hosts?: string[];
	trailingSlash?: TrailingSlash;
	fetch: FetchLike;
}

export function createCloudflareProvider(config: CloudflareConfig): Provider {
	return new CloudflareProvider(config);
}

/**
 * The site's Web Analytics view in the Cloudflare dashboard.
 *
 * The dashboard filters by site tag in the query string; without a tag
 * the account-level list is the closest useful place to send someone.
 */
export function cloudflareDashboardUrl(accountId: string, siteTag: string): string | null {
	if (!accountId) return null;
	const base = `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/web-analytics`;
	return siteTag ? `${base}/overview?siteTag~in=${encodeURIComponent(siteTag)}` : `${base}/sites`;
}

class CloudflareProvider implements Provider {
	readonly id = "cloudflare" as const;
	readonly capabilities = CLOUDFLARE_CAPABILITIES;

	#config: CloudflareConfig;

	constructor(config: CloudflareConfig) {
		this.#config = config;
	}

	get #hosts(): string[] {
		return [...new Set((this.#config.hosts ?? []).map(normalizeHost).filter(Boolean))];
	}

	get #slash(): TrailingSlash {
		return this.#config.trailingSlash ?? "ignore";
	}

	dashboardUrl(): string | null {
		return cloudflareDashboardUrl(this.#config.accountId, this.#config.siteTag);
	}

	async validate(): Promise<Result<true>> {
		// A real query against the configured site, not a token ping: the
		// failure we most need to catch is a token that authenticates fine
		// and cannot see this account's analytics.
		const query = `
query EmDashAnalyticsValidate($account: string!, $siteTag: string!) {
	viewer { accounts(filter: { accountTag: $account }) {
		${RUM_DATASET}(limit: 1, filter: { siteTag: $siteTag, bot: 0 }) { count }
	} }
}`.trim();
		const res = await this.#graphql(query, {
			account: this.#config.accountId,
			siteTag: this.#config.siteTag,
		});
		if (!res.ok) return res;
		const account = firstAccount(res.value);
		if (!account) return failure("cfNoAccount");
		return { ok: true, value: true };
	}

	/**
	 * Sites this token can see, without asking for a broader scope.
	 *
	 * `GET /accounts/{id}/rum/site_info/list` is the obvious way to do this
	 * and it is 403 with Account Analytics Read — confirmed live. It needs
	 * Account Settings Read, which also grants "read access to account
	 * membership", and the plugin will not ask an operator for that just to
	 * fill a dropdown. Grouping the dataset itself gives the same list.
	 *
	 * The tradeoff, stated so the UI can say it: a site with no traffic in
	 * the window cannot appear here, so the settings page needs a way to
	 * type a tag in by hand.
	 */
	async discoverSites(range: DateRange): Promise<Result<Site[]>> {
		const query = `
query EmDashAnalyticsSites($account: string!, $since: Date!, $until: Date!) {
	viewer { accounts(filter: { accountTag: $account }) {
		${RUM_DATASET}(
			limit: ${MAX_PAGE_SIZE}
			filter: { date_geq: $since, date_leq: $until, bot: 0 }
			orderBy: [count_DESC]
		) { count dimensions { siteTag requestHost } }
	} }
}`.trim();
		const res = await this.#graphql(query, {
			account: this.#config.accountId,
			since: range.since,
			until: range.until,
		});
		if (!res.ok) return res;
		const account = firstAccount(res.value);
		if (!account) return failure("cfNoAccount");

		const byTag = new Map<string, Site>();
		for (const row of asArray(account[RUM_DATASET])) {
			if (!isRecord(row)) continue;
			const dims = isRecord(row.dimensions) ? row.dimensions : {};
			const siteTag = typeof dims.siteTag === "string" ? dims.siteTag : null;
			if (!siteTag) continue;
			const host = typeof dims.requestHost === "string" ? normalizeHost(dims.requestHost) : "";
			const existing = byTag.get(siteTag) ?? { siteTag, hosts: [], pageviews: 0 };
			if (host && !existing.hosts.includes(host)) existing.hosts.push(host);
			existing.pageviews = (existing.pageviews ?? 0) + numberAt(row, "count");
			byTag.set(siteTag, existing);
		}
		return { ok: true, value: [...byTag.values()].sort((a, b) => (b.pageviews ?? 0) - (a.pageviews ?? 0)) };
	}

	async retention(): Promise<Result<Retention>> {
		const query = `
query EmDashAnalyticsRetention($account: string!) {
	viewer { accounts(filter: { accountTag: $account }) {
		settings { ${RUM_DATASET} { notOlderThan maxDuration maxPageSize } }
	} }
}`.trim();
		const res = await this.#graphql(query, { account: this.#config.accountId });
		if (!res.ok) return res;
		const account = firstAccount(res.value);
		if (!account) return failure("cfNoAccount");
		const settings = isRecord(account.settings) ? account.settings : {};
		const probe = isRecord(settings[RUM_DATASET]) ? (settings[RUM_DATASET] as Record<string, unknown>) : null;
		if (!probe) return failure("cfNoRetention");

		// The API answers in seconds; days are what the rest of the plugin
		// reasons in.
		return {
			ok: true,
			value: {
				notOlderThanDays: secondsToDays(probe.notOlderThan),
				maxDurationDays: secondsToDays(probe.maxDuration),
				maxPageSize: numberAt(probe, "maxPageSize") || MAX_PAGE_SIZE,
			},
		};
	}

	async overview(range: DateRange): Promise<Result<Overview>> {
		const guard = guardRange(range);
		if (guard) return { ok: false, error: guard };

		const { filter, decls, vars } = this.#filter(range);
		const days = enumerateDays(range.since, range.until).length;
		// `limit` truncates without an error, so the series limit must be
		// comfortably above the number of days it can possibly return.
		const seriesLimit = Math.min(MAX_PAGE_SIZE, Math.max(days * 2, 32));

		const query = `
query EmDashAnalyticsOverview(${decls}) {
	viewer { accounts(filter: { accountTag: $account }) {
		totals: ${RUM_DATASET}(limit: 1, filter: ${filter}) {
			count sum { visits } avg { sampleInterval }
		}
		series: ${RUM_DATASET}(limit: ${seriesLimit}, filter: ${filter}, orderBy: [date_ASC]) {
			count sum { visits } avg { sampleInterval } dimensions { date }
		}
		pages: ${RUM_DATASET}(limit: ${TOP_PATHS_LIMIT}, filter: ${filter}, orderBy: [count_DESC]) {
			count sum { visits } avg { sampleInterval } dimensions { requestPath }
		}
		refs: ${RUM_DATASET}(limit: ${REFERRERS_LIMIT}, filter: ${filter}, orderBy: [sum_visits_DESC]) {
			count sum { visits } dimensions { refererHost }
		}
		geo: ${RUM_DATASET}(limit: ${COUNTRIES_LIMIT}, filter: ${filter}, orderBy: [count_DESC]) {
			count sum { visits } dimensions { countryName }
		}
	} }
}`.trim();

		const res = await this.#graphql(query, vars);
		if (!res.ok) return res;
		return this.#parseOverview(res.value, seriesLimit);
	}

	async paths(paths: string[], range: DateRange): Promise<Result<PathDayRow[]>> {
		const guard = guardRange(range);
		if (guard) return { ok: false, error: guard };
		if (paths.length === 0) return { ok: true, value: [] };

		const days = enumerateDays(range.since, range.until).length;
		// `requestPath_in` matches the path exactly as the browser requested
		// it, and a site that serves both spellings reports both: asking only
		// for the normalized one misses every view of the other.
		const asked = [...new Set(paths.flatMap(spellings))];
		// The alias groups by date AND path, so the response can hold
		// asked paths x days rows. The plan set no limit here at all, which
		// would have truncated silently at the default.
		const groups = asked.length * days;
		if (groups > MAX_PAGE_SIZE) {
			return failure("cfTooManyGroups", { paths: asked.length, days, max: MAX_PAGE_SIZE });
		}
		const limit = Math.min(MAX_PAGE_SIZE, groups + 10);

		const { filter, decls, vars } = this.#filter(range, { paths: true });
		const query = `
query EmDashAnalyticsPaths(${decls}) {
	viewer { accounts(filter: { accountTag: $account }) {
		${RUM_DATASET}(limit: ${limit}, filter: ${filter}) {
			count sum { visits } avg { sampleInterval } dimensions { date requestPath }
		}
	} }
}`.trim();

		const res = await this.#graphql(query, { ...vars, paths: asked });
		if (!res.ok) return res;
		const account = firstAccount(res.value);
		if (!account) return failure("cfNoAccount");

		const rows = asArray(account[RUM_DATASET]);
		if (rows.length >= limit) {
			return failure("cfTruncated");
		}

		const byDay = new Map<string, PathDayRow>();
		for (const row of rows) {
			if (!isRecord(row)) continue;
			const dims = isRecord(row.dimensions) ? row.dimensions : {};
			const date = typeof dims.date === "string" ? dims.date : null;
			const rawPath = typeof dims.requestPath === "string" ? dims.requestPath : null;
			if (!date || rawPath === null) continue;
			const path = normalizePath(rawPath, this.#slash);
			const pageviews = numberAt(row, "count");
			const visits = numberAt(isRecord(row.sum) ? row.sum : undefined, "visits");
			const sampleInterval = sampleIntervalOf(row);
			const key = `${date}|${path}`;
			const acc = byDay.get(key);
			if (acc) {
				acc.pageviews += pageviews;
				acc.visits += visits;
				acc.sampleInterval = Math.max(acc.sampleInterval, sampleInterval);
			} else {
				byDay.set(key, { date, path, pageviews, visits, sampleInterval });
			}
		}
		const out = [...byDay.values()];
		return { ok: true, value: out };
	}

	/**
	 * Build the shared filter literal.
	 *
	 * `bot: 0` and the host list go on **every** query, not just some of
	 * them: a filter that differs between the totals alias and the series
	 * alias produces a chart whose columns do not add up to its header.
	 */
	#filter(range: DateRange, opts: { paths?: boolean } = {}) {
		const hosts = this.#hosts;
		const parts = [
			"siteTag: $siteTag",
			"date_geq: $since",
			"date_leq: $until",
			"bot: 0",
			"requestPath_notlike: $internal",
		];
		const decls = ["$account: string!", "$siteTag: string!", "$since: Date!", "$until: Date!", "$internal: string!"];
		const vars: Record<string, unknown> = {
			account: this.#config.accountId,
			siteTag: this.#config.siteTag,
			since: range.since,
			until: range.until,
			internal: INTERNAL_PATHS,
		};

		// Declaring an unused variable is a GraphQL error, so the host and
		// path arguments are only mentioned when they are actually used.
		if (hosts.length > 0) {
			parts.push("requestHost_in: $hosts");
			decls.push("$hosts: [string!]");
			vars.hosts = hosts;
		}
		if (opts.paths) {
			parts.push("requestPath_in: $paths");
			decls.push("$paths: [string!]");
		}

		return { filter: `{ ${parts.join(", ")} }`, decls: decls.join(", "), vars };
	}

	async #graphql(query: string, variables: Record<string, unknown>): Promise<Result<unknown>> {
		let response: Response;
		try {
			response = await this.#config.fetch(GRAPHQL_ENDPOINT, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#config.apiToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ query, variables }),
			});
		} catch (error) {
			return failure("cfUnreachable", { detail: error instanceof Error ? error.message : String(error) });
		}

		if (!response.ok) {
			return httpFailure(response.status);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return failure("cfNotJson");
		}

		const graphqlError = firstGraphqlError(payload);
		if (graphqlError) return graphqlError;

		return { ok: true, value: payload };
	}

	#parseOverview(payload: unknown, seriesLimit: number): Result<Overview> {
		const account = firstAccount(payload);
		if (!account) return failure("cfNoAccount");

		const totalsRow = asArray(account.totals)[0];
		const totals = {
			pageviews: numberAt(totalsRow, "count"),
			visits: numberAt(isRecord(totalsRow) ? totalsRow.sum : undefined, "visits"),
			sampleInterval: sampleIntervalOf(totalsRow),
		};

		const series: DailyRow[] = [];
		for (const row of asArray(account.series)) {
			if (!isRecord(row)) continue;
			const dims = isRecord(row.dimensions) ? row.dimensions : {};
			const date = typeof dims.date === "string" ? dims.date : null;
			if (!date) continue;
			series.push({
				date,
				pageviews: numberAt(row, "count"),
				visits: numberAt(isRecord(row.sum) ? row.sum : undefined, "visits"),
				sampleInterval: sampleIntervalOf(row),
			});
		}

		const topPaths: PathRow[] = [];
		for (const row of asArray(account.pages)) {
			if (!isRecord(row)) continue;
			const dims = isRecord(row.dimensions) ? row.dimensions : {};
			const raw = typeof dims.requestPath === "string" ? dims.requestPath : null;
			if (raw === null) continue;
			const path = normalizePath(raw, this.#slash);
			if (isInternalPath(path)) continue;
			topPaths.push({
				path,
				pageviews: numberAt(row, "count"),
				visits: numberAt(isRecord(row.sum) ? row.sum : undefined, "visits"),
				sampleInterval: sampleIntervalOf(row),
			});
		}

		return {
			ok: true,
			value: {
				totals,
				series,
				topPaths: foldByKey(topPaths),
				referrers: labelled(account.refs, "refererHost", DIRECT_REFERRER),
				countries: labelled(account.geo, "countryName", ""),
				truncated:
					asArray(account.series).length >= seriesLimit ||
					asArray(account.pages).length >= TOP_PATHS_LIMIT ||
					asArray(account.refs).length >= REFERRERS_LIMIT ||
					asArray(account.geo).length >= COUNTRIES_LIMIT,
			},
		};
	}
}

/**
 * Cloudflare reports direct traffic as an empty `refererHost`, and on
 * one small site that was 20 of 24 visits. Rendering it as a blank row in the
 * referrers table would look like a bug.
 */
export const DIRECT_REFERRER = "(direct)";

function httpFailure(status: number) {
	if (status === 403) return failure("cfForbidden");
	if (status === 429) return failure("cfRateLimited");
	return failure("cfHttp", { status });
}

/**
 * Turn a GraphQL error list into one sentence.
 *
 * "not authorized for that account" earns its own branch because it is the
 * single most confusing failure this plugin can hit: a token carrying
 * *Zone* Analytics Read answers `viewer { zones }` perfectly happily and
 * fails every account-scoped query with that message, so the token looks
 * valid and the plugin looks broken. Cost us a diagnostic detour on
 * 2026-09-20; it should cost an operator one sentence.
 */
function firstGraphqlError(payload: unknown): { ok: false; error: string; problem?: Problem } | null {
	if (!isRecord(payload)) return { ok: false, error: "Unexpected response shape" };
	const errors = payload.errors;
	if (!Array.isArray(errors) || errors.length === 0) return null;
	const first = errors[0];
	const message = isRecord(first) && typeof first.message === "string" ? first.message : "unknown error";
	if (message.includes("not authorized for that account")) return failure("cfZoneToken");
	return { ok: false, error: `GraphQL: ${message}` };
}

/**
 * Refuse a window that would come back tenfold-quantized.
 *
 * The scheduler already clamps, so reaching this is a programming error
 * rather than a configuration one — but silently returning sampled numbers
 * as though they were exact is the failure this whole design exists to
 * avoid, so the adapter refuses rather than trusting its caller.
 */
/** A normalized path and its other spelling: `/about/` and `/about`. The root has one. */
function spellings(path: string): string[] {
	const bare = path.replace(/\/+$/, "");
	return bare === "" ? ["/"] : [bare, `${bare}/`];
}

function guardRange(range: DateRange): string | null {
	const span = daysBetween(range.since, range.until);
	if (span < 0) return `Inverted range: ${range.since} is after ${range.until}`;
	if (span > UNSAMPLED_WINDOW_DAYS) {
		return `Refusing a ${span}-day window: Cloudflare serves any query starting more than ${UNSAMPLED_WINDOW_DAYS} days back from its ~10% sample, which would quantize every day in the result.`;
	}
	return null;
}

function labelled(raw: unknown, dimension: string, emptyLabel: string): LabelledRow[] {
	const out: LabelledRow[] = [];
	for (const row of asArray(raw)) {
		if (!isRecord(row)) continue;
		const dims = isRecord(row.dimensions) ? row.dimensions : {};
		const value = dims[dimension];
		if (typeof value !== "string") continue;
		out.push({
			label: value === "" ? emptyLabel : value,
			visits: numberAt(isRecord(row.sum) ? row.sum : undefined, "visits"),
			pageviews: numberAt(row, "count"),
		});
	}
	return out;
}

/**
 * Normalization can map two reported paths onto one, so their numbers have
 * to be added rather than one of them silently winning.
 */
function foldByKey(rows: PathRow[]): PathRow[] {
	const merged = new Map<string, PathRow>();
	for (const row of rows) {
		const existing = merged.get(row.path);
		if (!existing) {
			merged.set(row.path, { ...row });
			continue;
		}
		existing.pageviews += row.pageviews;
		existing.visits += row.visits;
		existing.sampleInterval = Math.max(existing.sampleInterval, row.sampleInterval);
	}
	return [...merged.values()].sort((a, b) => b.pageviews - a.pageviews);
}

function secondsToDays(value: unknown): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
	return Math.floor(n / 86_400);
}

/** Absent sampling metadata means "counted everything", which is the API's own default. */
function sampleIntervalOf(row: unknown): number {
	if (!isRecord(row)) return 1;
	const avg = isRecord(row.avg) ? row.avg : undefined;
	const n = numberAt(avg, "sampleInterval");
	return n > 0 ? n : 1;
}

function firstAccount(payload: unknown): Record<string, unknown> | null {
	if (!isRecord(payload)) return null;
	const data = isRecord(payload.data) ? payload.data : payload;
	const viewer = isRecord(data.viewer) ? data.viewer : null;
	const account = viewer ? asArray(viewer.accounts)[0] : undefined;
	return isRecord(account) ? account : null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function numberAt(value: unknown, key: string): number {
	if (!isRecord(value)) return 0;
	const n = value[key];
	return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { Day };
