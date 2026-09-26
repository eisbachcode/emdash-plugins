/**
 * The HTTP check for a single URL, and the rule that turns a run of
 * checks into a finding.
 *
 * Kept separate from the sweep so it can be tested with a fake fetch and
 * so the retry policy lives in one place.
 */

import type { PluginContext } from "emdash/plugin";

export type CheckState =
	/** 2xx. */
	| "ok"
	/** 3xx with a Location on an internal link — often fixable with a redirect rule. */
	| "redirect"
	/** 404, 410, or a domain that no longer resolves — the link is wrong. */
	| "broken"
	/** Anything that does not show whether the link works. See `CheckReason`. */
	| "unknown"
	/** The URL does not parse. */
	| "malformed";

export type CheckReason =
	/** 404 or 410. */
	| "not-found"
	/** The hostname has no A or AAAA record. */
	| "dead-domain"
	/** 5xx. Counts as a failure, but has to last before it is reported. */
	| "server-error"
	/** 401 or 407: the target wants credentials. */
	| "auth"
	/** 403 or 451: the target refuses this client, often a datacentre IP. */
	| "blocked"
	/** 429. */
	| "rate-limited"
	/** Any other status that is neither success nor a clear failure. */
	| "unexpected-status"
	/** An outbound link redirected more often than the host follows. */
	| "too-many-redirects"
	/** The request never produced a response. */
	| "network-error";

export interface CheckResult {
	state: CheckState;
	reason: CheckReason | null;
	status: number | null;
	/** Redirect target, when `state === "redirect"`. */
	location: string | null;
	/** Where an outbound link ended up, when it redirected on the way. */
	finalUrl: string | null;
	/** When a rate-limited target may be asked again, as an ISO timestamp. */
	retryAfter: string | null;
	/** Error message, when the request never produced a response. */
	error: string | null;
	/** Fetches the check made through `ctx.http`: none, HEAD, or HEAD and GET. */
	requests: number;
	/**
	 * Outbound subrequests those fetches may have cost in-process: three per
	 * request, since emdash first resolves the host over DNS-over-HTTPS (A
	 * and AAAA), and up to six requests for a fetch that followed redirects.
	 * The response does not say how many hops it took, so that is charged in
	 * full.
	 */
	outbound: number;
}

export interface CheckOptions {
	/**
	 * An outbound link follows its redirects and is judged by the final
	 * response, since the hop is not something the site can fix. An internal
	 * hop is the finding, because core's redirect engine can fix it.
	 */
	outbound: boolean;
}

/**
 * What emdash's SSRF guard throws when a hostname has no A or AAAA record.
 * The guard resolves every target before the request is made, so a dead
 * domain surfaces as this rejection, not as a response, and the error has
 * no code to match on. Any other resolver failure (a DoH timeout, SERVFAIL)
 * reads differently and stays `unknown`.
 */
const NO_ADDRESSES = "Hostname resolved to no addresses";

const SUBREQUESTS_PER_REQUEST = 3;
/** emdash follows at most five redirects, so a fetch is at most six requests. */
const REQUESTS_PER_FOLLOWED_FETCH = 6;

/** The most outbound subrequests a check can cost: HEAD and GET, each at its worst. */
export function worstOutbound(options: CheckOptions): number {
	return 2 * fetchCost(options, true);
}

function fetchCost(options: CheckOptions, redirected: boolean): number {
	return SUBREQUESTS_PER_REQUEST * (options.outbound && redirected ? REQUESTS_PER_FOLLOWED_FETCH : 1);
}

/**
 * What emdash throws after following its maximum number of redirects —
 * lower-case in-process, capitalised by the sandbox bridge.
 */
const TOO_MANY_REDIRECTS = /too many redirects/i;

export function malformedResult(error: string): CheckResult {
	return {
		state: "malformed",
		reason: null,
		status: null,
		location: null,
		finalUrl: null,
		retryAfter: null,
		error,
		requests: 0,
		outbound: 0,
	};
}

export async function checkUrl(ctx: PluginContext, url: string, options: CheckOptions): Promise<CheckResult> {
	if (!ctx.http) {
		return noResponse("unknown", "network-error", "network capability not granted", 0, 0);
	}

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return malformedResult("unparseable URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return malformedResult(`unsupported scheme ${parsed.protocol}`);
	}

	const redirect = options.outbound ? "follow" : "manual";
	let requests = 0;
	let outbound = 0;
	try {
		requests++;
		// Charged at its worst before the fetch, so one that throws is still paid for.
		outbound += fetchCost(options, true);
		const head = await ctx.http.fetch(url, { method: "HEAD", redirect });
		outbound += fetchCost(options, head.redirected) - fetchCost(options, true);
		// Sent to the URL the HEAD ended on, which saves the redirect hops.
		const retry = retryWithGet(head.status, options);
		if (retry) {
			requests++;
			outbound += fetchCost(options, true);
		}
		const response = retry ? await ctx.http.fetch(head.url || url, { method: "GET", redirect }) : head;
		if (retry) outbound += fetchCost(options, response.redirected) - fetchCost(options, true);

		const { state, reason } = classifyStatus(response.status, options);
		const landedAt = response.redirected ? response.url : head.redirected ? head.url : "";
		const finalUrl = landedAt && landedAt !== url ? landedAt : null;
		return {
			state,
			reason,
			status: response.status,
			location: state === "redirect" ? response.headers.get("location") : null,
			finalUrl,
			retryAfter:
				reason === "rate-limited" ? parseRetryAfter(response.headers.get("retry-after"), Date.now()) : null,
			error: null,
			requests,
			outbound,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes(NO_ADDRESSES)) return noResponse("broken", "dead-domain", message, requests, outbound);
		if (TOO_MANY_REDIRECTS.test(message)) {
			return noResponse("unknown", "too-many-redirects", message, requests, outbound);
		}
		return noResponse("unknown", "network-error", message, requests, outbound);
	}
}

function noResponse(
	state: CheckState,
	reason: CheckReason,
	error: string,
	requests: number,
	outbound: number,
): CheckResult {
	return {
		state,
		reason,
		status: null,
		location: null,
		finalUrl: null,
		retryAfter: null,
		error,
		requests,
		outbound,
	};
}

/**
 * Whether a failed HEAD is worth a GET. Plenty of outbound servers answer
 * HEAD with an error that GET does not give. The site's own pages answer
 * HEAD as they answer GET, so an internal link only retries when HEAD is
 * refused outright. A 429 asked us to back off and never gets a retry.
 */
function retryWithGet(status: number, options: CheckOptions): boolean {
	if (status < 400 || status === 429) return false;
	return options.outbound || status === 405 || status === 501;
}

function classifyStatus(
	status: number,
	options: CheckOptions,
): { state: CheckState; reason: CheckReason | null } {
	if (status >= 200 && status < 300) return { state: "ok", reason: null };
	// A 3xx that reaches us while following has no usable Location.
	if (status >= 300 && status < 400) {
		return options.outbound
			? { state: "unknown", reason: "unexpected-status" }
			: { state: "redirect", reason: null };
	}
	if (status === 404 || status === 410) return { state: "broken", reason: "not-found" };
	if (status === 401 || status === 407) return { state: "unknown", reason: "auth" };
	if (status === 403 || status === 451) return { state: "unknown", reason: "blocked" };
	if (status === 429) return { state: "unknown", reason: "rate-limited" };
	if (status >= 500) return { state: "unknown", reason: "server-error" };
	return { state: "unknown", reason: "unexpected-status" };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A `Retry-After` header as an ISO timestamp: delay-seconds or an HTTP
 * date, held between a minute and a week so a hostile or broken value can
 * neither hammer the target nor park the link for good.
 */
export function parseRetryAfter(value: string | null, now: number): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	const at = /^\d+$/.test(trimmed) ? now + Number(trimmed) * 1000 : Date.parse(trimmed);
	if (!Number.isFinite(at)) return null;
	return new Date(Math.min(Math.max(at, now + MINUTE), now + 7 * DAY)).toISOString();
}

/**
 * How long a failure has to persist before it is reported. The count
 * threshold alone would let two manual sweeps a minute apart report a
 * link. Twelve hours still reports a 404 on the second night of a nightly
 * schedule; sixty hours is a server that failed three nightly sweeps.
 */
const NOT_FOUND_SPAN_MS = 12 * HOUR;
const SERVER_ERROR_SPAN_MS = 60 * HOUR;

export interface LinkHistory {
	state: CheckState;
	reported: boolean;
	consecutiveFailures: number;
	firstFailedAt: string | null;
}

export interface Verdict extends LinkHistory {
	/**
	 * False when the result showed nothing and an earlier verdict stands.
	 * The caller then keeps that verdict's evidence too.
	 */
	conclusive: boolean;
}

/**
 * Fold one check result into a link's history.
 *
 * Only a clear failure advances the count. A blocked, rate-limited or
 * unreachable target says nothing about the link either way, so the last
 * conclusive verdict stands. A link already reported stays reported while
 * it keeps failing, whatever the failure.
 */
export function judge(
	previous: LinkHistory | null,
	result: CheckResult,
	now: Date,
	threshold: number,
): Verdict {
	if (result.state === "ok" || result.state === "redirect") {
		return {
			state: result.state,
			reported: result.state === "redirect",
			consecutiveFailures: 0,
			firstFailedAt: null,
			conclusive: true,
		};
	}

	const serverError = result.reason === "server-error";
	if (result.state === "unknown" && !serverError) {
		if (previous && previous.state !== "unknown") return { ...history(previous), conclusive: false };
		return {
			state: "unknown",
			reported: false,
			consecutiveFailures: previous?.consecutiveFailures ?? 0,
			firstFailedAt: previous?.firstFailedAt ?? null,
			conclusive: true,
		};
	}

	const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
	const firstFailedAt = previous?.firstFailedAt ?? now.toISOString();
	const failingFor = now.getTime() - Date.parse(firstFailedAt);
	const counted = consecutiveFailures >= threshold;
	const stillFailing = previous?.reported === true && (previous.state === "broken" || previous.state === "malformed");

	// Waiting cannot fix a URL that does not parse, so the count alone decides.
	if (result.state === "malformed") {
		return {
			state: "malformed",
			reported: stillFailing || counted,
			consecutiveFailures,
			firstFailedAt,
			conclusive: true,
		};
	}
	if (serverError) {
		const reported = stillFailing || (counted && failingFor >= SERVER_ERROR_SPAN_MS);
		return { state: reported ? "broken" : "unknown", reported, consecutiveFailures, firstFailedAt, conclusive: true };
	}
	return {
		state: "broken",
		reported: stillFailing || (counted && failingFor >= NOT_FOUND_SPAN_MS),
		consecutiveFailures,
		firstFailedAt,
		conclusive: true,
	};
}

function history(previous: LinkHistory): LinkHistory {
	return {
		state: previous.state,
		reported: previous.reported,
		consecutiveFailures: previous.consecutiveFailures,
		firstFailedAt: previous.firstFailedAt ?? null,
	};
}
