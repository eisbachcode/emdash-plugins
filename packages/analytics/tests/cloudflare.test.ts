import { describe, expect, it } from "vitest";

import {
	cloudflareDashboardUrl,
	createCloudflareProvider,
	DIRECT_REFERRER,
	RUM_DATASET,
} from "../src/providers/cloudflare.js";
import type { FetchLike } from "../src/providers/types.js";

/** Captures what the adapter sent, and replies with what the test dictates. */
function recorder(reply: unknown, status = 200) {
	const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
	const fetch: FetchLike = async (_url, init) => {
		const body = JSON.parse(String(init?.body ?? "{}"));
		calls.push({ query: body.query, variables: body.variables });
		return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	};
	return { calls, fetch };
}

const RANGE = { since: "2026-09-18", until: "2026-09-20" };

function provider(fetch: FetchLike, over: Partial<Parameters<typeof createCloudflareProvider>[0]> = {}) {
	return createCloudflareProvider({
		apiToken: "cfat_secret",
		accountId: "acct-1",
		siteTag: "tag-1",
		hosts: ["example.com", "www.example.com"],
		fetch,
		...over,
	});
}

/**
 * The dataset aliases' filters, so each can be asserted separately. The
 * `accounts(filter: { accountTag: … })` wrapper is not one of them.
 */
function aliasFilters(query: string): string[] {
	return [...query.matchAll(/filter: (\{[^}]*\})/g)].map((m) => m[1]!).filter((f) => !f.includes("accountTag"));
}

const EMPTY_OK = { data: { viewer: { accounts: [{ totals: [], series: [], pages: [], refs: [], geo: [] }] } } };

describe("the two bugs the old package shipped", () => {
	it("filters bots out of every single alias", async () => {
		// The old query had no `bot: 0` anywhere, so bot hits were page views.
		// Asserting "every alias" rather than "the query contains bot: 0"
		// matters: a totals alias that filters differently from the series
		// alias produces a chart whose columns do not add up to its header.
		const { calls, fetch } = recorder(EMPTY_OK);
		await provider(fetch).overview(RANGE);
		const filters = aliasFilters(calls[0]!.query);
		expect(filters).toHaveLength(5);
		for (const f of filters) expect(f).toContain("bot: 0");
	});

	it("sends the site tag as siteTag, never as a beacon token", async () => {
		// The old README told operators to paste the beacon `token` here.
		// Confirmed live on 2026-09-20: site_tag and site_token differ on
		// every site, so that query matched nothing at all.
		const { calls, fetch } = recorder(EMPTY_OK);
		await provider(fetch, { siteTag: "ab3dbd732b894b9796fe16087182fe3f" }).overview(RANGE);
		expect(calls[0]!.variables.siteTag).toBe("ab3dbd732b894b9796fe16087182fe3f");
		for (const f of aliasFilters(calls[0]!.query)) expect(f).toContain("siteTag: $siteTag");
	});
});

describe("query construction", () => {
	it("puts the host allow-list on every alias so previews are excluded", async () => {
		const { calls, fetch } = recorder(EMPTY_OK);
		await provider(fetch).overview(RANGE);
		for (const f of aliasFilters(calls[0]!.query)) expect(f).toContain("requestHost_in: $hosts");
		// Both spellings survive: they are distinct requestHost values.
		expect(calls[0]!.variables.hosts).toEqual(["example.com", "www.example.com"]);
	});

	it("omits the host variable entirely when no hosts are configured", async () => {
		// Declaring an unused GraphQL variable is a hard error, and an empty
		// `requestHost_in` would match nothing rather than everything.
		const { calls, fetch } = recorder(EMPTY_OK);
		await provider(fetch, { hosts: [] }).overview(RANGE);
		expect(calls[0]!.query).not.toContain("$hosts");
		expect(calls[0]!.variables.hosts).toBeUndefined();
	});

	it("keeps admin page views out of every alias, the totals included", async () => {
		// Cloudflare's automatic setup injects the beacon into every HTML
		// response, `/_emdash/admin` included, so editor sessions reach the
		// dataset. The totals alias has no path dimension: dropping rows after
		// reading could clean up top pages but never the headline number.
		const { calls, fetch } = recorder(EMPTY_OK);
		await provider(fetch).overview(RANGE);
		for (const f of aliasFilters(calls[0]!.query)) expect(f).toContain("requestPath_notlike: $internal");
		expect(calls[0]!.variables.internal).toBe("/_emdash/%");
	});

	it("selects the sampling factor wherever it selects a count", async () => {
		const { calls, fetch } = recorder(EMPTY_OK);
		await provider(fetch).overview(RANGE);
		const q = calls[0]!.query;
		expect(q).toContain("avg { sampleInterval }");
		expect(q.match(/avg \{ sampleInterval \}/g)!.length).toBeGreaterThanOrEqual(3);
	});

	it("names the verified dataset", async () => {
		const { calls, fetch } = recorder(EMPTY_OK);
		await provider(fetch).overview(RANGE);
		expect(RUM_DATASET).toBe("rumPageloadEventsAdaptiveGroups");
		expect(calls[0]!.query).toContain(RUM_DATASET);
	});
});

describe("the sampling guard", () => {
	it("refuses a window that would come back tenfold-quantized", async () => {
		const { calls, fetch } = recorder(EMPTY_OK);
		const res = await provider(fetch).overview({ since: "2026-09-06", until: "2026-09-20" });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/10% sample/);
		// And it refuses locally: no request is worth sending.
		expect(calls).toHaveLength(0);
	});

	it("allows a window that sits exactly on the cliff", async () => {
		const { fetch } = recorder(EMPTY_OK);
		const res = await provider(fetch).overview({ since: "2026-09-13", until: "2026-09-20" });
		expect(res.ok).toBe(true);
	});

	it("rejects an inverted range", async () => {
		const { fetch } = recorder(EMPTY_OK);
		const res = await provider(fetch).overview({ since: "2026-09-20", until: "2026-09-18" });
		expect(res.ok).toBe(false);
	});
});

describe("per-path batching", () => {
	it("sets a limit above paths x days, because limit truncates silently", async () => {
		const { calls, fetch } = recorder({ data: { viewer: { accounts: [{ [RUM_DATASET]: [] }] } } });
		await provider(fetch).paths(["/a/", "/b/"], RANGE);
		// 2 paths x 3 days = 6 groups; the limit must exceed that.
		const limit = Number(/limit: (\d+)/.exec(calls[0]!.query)![1]);
		expect(limit).toBeGreaterThan(6);
	});

	it("refuses a chunk whose groups would exceed the page size", async () => {
		const { calls, fetch } = recorder(EMPTY_OK);
		const many = Array.from({ length: 4000 }, (_, i) => `/p${i}/`);
		const res = await provider(fetch).paths(many, RANGE);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/group page size/);
		expect(calls).toHaveLength(0);
	});

	it("reports truncation rather than returning a short answer as complete", async () => {
		// Fill the response to exactly the limit the adapter asks for: two
		// paths in two spellings over three days, plus its margin of ten.
		const rows = Array.from({ length: 22 }, (_, i) => ({
			count: 1,
			sum: { visits: 1 },
			avg: { sampleInterval: 1 },
			dimensions: { date: "2026-09-20", requestPath: `/p${i}/` },
		}));
		const { fetch } = recorder({ data: { viewer: { accounts: [{ [RUM_DATASET]: rows }] } } });
		const res = await provider(fetch).paths(["/a/", "/b/"], RANGE);
		expect(res.ok).toBe(false);
	});

	it("does not call the API for an empty path list", async () => {
		const { calls, fetch } = recorder(EMPTY_OK);
		const res = await provider(fetch).paths([], RANGE);
		expect(res).toEqual({ ok: true, value: [] });
		expect(calls).toHaveLength(0);
	});

	it("asks for both spellings of each path, since the filter matches the path as requested", async () => {
		// Measured on eisbachcode.de: Cloudflare reported /contact while the
		// index held /contact/, and a filter on the index's spelling alone
		// returned nothing for every page but the root.
		const { calls, fetch } = recorder({ data: { viewer: { accounts: [{ [RUM_DATASET]: [] }] } } });
		await provider(fetch).paths(["/contact/", "/"], RANGE);
		expect(new Set(calls[0]!.variables.paths as string[])).toEqual(new Set(["/contact", "/contact/", "/"]));
	});

	it("adds up both spellings' rows for the same day", async () => {
		const row = (requestPath: string, count: number) => ({
			count,
			sum: { visits: count },
			avg: { sampleInterval: 1 },
			dimensions: { date: "2026-09-20", requestPath },
		});
		const { fetch } = recorder({
			data: { viewer: { accounts: [{ [RUM_DATASET]: [row("/contact", 2), row("/contact/", 3)] }] } },
		});
		const res = await provider(fetch, { trailingSlash: "always" }).paths(["/contact/"], RANGE);
		expect(res).toEqual({
			ok: true,
			value: [{ date: "2026-09-20", path: "/contact/", pageviews: 5, visits: 5, sampleInterval: 1 }],
		});
	});

	it("normalizes the paths it returns", async () => {
		const rows = [
			{ count: 3, sum: { visits: 2 }, avg: { sampleInterval: 1 }, dimensions: { date: "2026-09-20", requestPath: "/datenschutz" } },
		];
		const { fetch } = recorder({ data: { viewer: { accounts: [{ [RUM_DATASET]: rows }] } } });
		const res = await provider(fetch).paths(["/datenschutz/"], RANGE);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.value[0]!.path).toBe("/datenschutz/");
	});
});

describe("parsing", () => {
	it("adds up two spellings that normalize to one path", async () => {
		// Real shape from the 2026-09-20 pull: /datenschutz and
		// /datenschutz/ arrived as separate rows for one page. Letting one
		// win would halve the number.
		const { fetch } = recorder({
			data: {
				viewer: {
					accounts: [
						{
							totals: [{ count: 4, sum: { visits: 3 }, avg: { sampleInterval: 1 } }],
							series: [],
							pages: [
								{ count: 1, sum: { visits: 1 }, avg: { sampleInterval: 1 }, dimensions: { requestPath: "/datenschutz" } },
								{ count: 3, sum: { visits: 2 }, avg: { sampleInterval: 1 }, dimensions: { requestPath: "/datenschutz/" } },
							],
							refs: [],
							geo: [],
						},
					],
				},
			},
		});
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.value.topPaths).toHaveLength(1);
		expect(res.value.topPaths[0]).toMatchObject({ path: "/datenschutz/", pageviews: 4, visits: 3 });
	});

	it("drops the bare admin path, which the query pattern does not cover", async () => {
		const row = (requestPath: string) => ({
			count: 2,
			sum: { visits: 1 },
			avg: { sampleInterval: 1 },
			dimensions: { requestPath },
		});
		const { fetch } = recorder({
			data: {
				viewer: {
					accounts: [{ totals: [], series: [], pages: [row("/_emdash"), row("/about")], refs: [], geo: [] }],
				},
			},
		});
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.value.topPaths.map((p) => p.path)).toEqual(["/about/"]);
	});

	it("labels the empty referrer instead of rendering a blank row", async () => {
		const { fetch } = recorder({
			data: {
				viewer: {
					accounts: [
						{
							totals: [],
							series: [],
							pages: [],
							refs: [
								{ count: 20, sum: { visits: 20 }, dimensions: { refererHost: "" } },
								{ count: 4, sum: { visits: 4 }, dimensions: { refererHost: "www.google.com" } },
							],
							geo: [],
						},
					],
				},
			},
		});
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.value.referrers.map((r) => r.label)).toEqual([DIRECT_REFERRER, "www.google.com"]);
	});

	it("keeps a missing day missing rather than inventing a zero", async () => {
		// A quiet day produces no row at all. Filling it with 0 here would
		// make "not fetched" and "no views" indistinguishable downstream.
		const { fetch } = recorder({
			data: {
				viewer: {
					accounts: [
						{
							totals: [],
							series: [
								{ count: 7, sum: { visits: 3 }, avg: { sampleInterval: 1 }, dimensions: { date: "2026-09-18" } },
								{ count: 4, sum: { visits: 3 }, avg: { sampleInterval: 1 }, dimensions: { date: "2026-09-20" } },
							],
							pages: [],
							refs: [],
							geo: [],
						},
					],
				},
			},
		});
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.value.series.map((d) => d.date)).toEqual(["2026-09-18", "2026-09-20"]);
	});

	it("defaults a missing sampling factor to exact", async () => {
		const { fetch } = recorder({
			data: { viewer: { accounts: [{ totals: [{ count: 5, sum: { visits: 5 } }], series: [], pages: [], refs: [], geo: [] }] } },
		});
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.value.totals.sampleInterval).toBe(1);
	});

	it("carries the sampling factor through when the data is estimated", async () => {
		const { fetch } = recorder({
			data: {
				viewer: {
					accounts: [{ totals: [{ count: 14, sum: { visits: 14 }, avg: { sampleInterval: 2.33 } }], series: [], pages: [], refs: [], geo: [] }],
				},
			},
		});
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.value.totals.sampleInterval).toBeCloseTo(2.33);
	});

	it("survives every branch of the response going missing", async () => {
		for (const payload of [
			{},
			{ data: {} },
			{ data: { viewer: {} } },
			{ data: { viewer: { accounts: [] } } },
			{ data: { viewer: { accounts: [{}] } } },
			{ data: { viewer: { accounts: [{ totals: "nonsense", pages: 42 }] } } },
		]) {
			const { fetch } = recorder(payload);
			const res = await provider(fetch).overview(RANGE);
			// Either a clean error or empty numbers, never a thrown exception.
			expect(typeof res.ok).toBe("boolean");
		}
	});
});

describe("error mapping", () => {
	it("explains a 403 in terms of the permission to fix", async () => {
		const { fetch } = recorder({}, 403);
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/Account Analytics/);
	});

	it("names the rate limit on a 429", async () => {
		const { fetch } = recorder({}, 429);
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/429/);
	});

	it("turns the Zone-versus-Account trap into one sentence", async () => {
		// A token with Zone Analytics Read answers viewer { zones } happily
		// and fails every account query with this message. Without the
		// branch the operator sees "GraphQL: not authorized for that
		// account" and checks the account ID, which is correct.
		const { fetch } = recorder({ data: null, errors: [{ message: "not authorized for that account" }] });
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toMatch(/Zone Analytics Read/);
			expect(res.error).toMatch(/account-scoped/);
		}
	});

	it("passes an unrecognised GraphQL error through verbatim", async () => {
		const { fetch } = recorder({ errors: [{ message: "something new" }] });
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toBe("GraphQL: something new");
	});

	it("reports a non-JSON body instead of throwing", async () => {
		const { fetch } = recorder("<html>maintenance</html>");
		const res = await provider(fetch).overview(RANGE);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/not JSON/);
	});

	it("turns a transport failure into a value", async () => {
		const fetch: FetchLike = async () => {
			throw new Error("network down");
		};
		const res = await provider(fetch).overview(RANGE);
		expect(res).toMatchObject({ ok: false, problem: { key: "cfUnreachable", params: { detail: "network down" } } });
		if (!res.ok) expect(res.error).toContain("network down");
	});
});

describe("site discovery", () => {
	it("groups hosts under their tag without needing Account Settings Read", async () => {
		const { calls, fetch } = recorder({
			data: {
				viewer: {
					accounts: [
						{
							[RUM_DATASET]: [
								{ count: 80, dimensions: { siteTag: "tag-a", requestHost: "example.com" } },
								{ count: 10, dimensions: { siteTag: "tag-a", requestHost: "www.example.com" } },
								{ count: 5, dimensions: { siteTag: "tag-b", requestHost: "other.example" } },
							],
						},
					],
				},
			},
		});
		const res = await provider(fetch).discoverSites({ since: "2026-08-21", until: "2026-09-20" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.value).toHaveLength(2);
		expect(res.value[0]).toMatchObject({ siteTag: "tag-a", pageviews: 90 });
		// Discovery is a plain analytics query, not the site-management API.
		expect(calls[0]!.query).toContain(RUM_DATASET);
	});
});

describe("retention", () => {
	it("converts the API's seconds into the days the plugin reasons in", async () => {
		// The live values on 2026-09-20.
		const { fetch } = recorder({
			data: {
				viewer: {
					accounts: [{ settings: { [RUM_DATASET]: { notOlderThan: 15897600, maxDuration: 8035200, maxPageSize: 10000 } } }],
				},
			},
		});
		const res = await provider(fetch).retention();
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.value).toEqual({ notOlderThanDays: 184, maxDurationDays: 93, maxPageSize: 10000 });
	});

	it("errors rather than guessing when the probe comes back empty", async () => {
		const { fetch } = recorder({ data: { viewer: { accounts: [{ settings: {} }] } } });
		const res = await provider(fetch).retention();
		expect(res.ok).toBe(false);
	});
});

describe("the dashboard link", () => {
	it("opens the site's own Web Analytics view", () => {
		const { fetch } = recorder(EMPTY_OK);
		expect(provider(fetch, { accountId: "acct-1", siteTag: "tag-1" }).dashboardUrl?.()).toBe(
			"https://dash.cloudflare.com/acct-1/web-analytics/overview?siteTag~in=tag-1",
		);
	});

	it("falls back to the account's site list without a tag, and to nothing without an account", () => {
		expect(cloudflareDashboardUrl("acct-1", "")).toBe("https://dash.cloudflare.com/acct-1/web-analytics/sites");
		expect(cloudflareDashboardUrl("", "tag-1")).toBeNull();
	});
});
