/**
 * The stored record: one row per link target — the URL actually requested
 * — checked once and shared by every entry that links to it.
 *
 * A row also carries the first few places that link to it and how many
 * there are, rebuilt by every sweep. Keeping them on the row rather than one
 * row per link keeps a sweep's writes to one per target, which matters on
 * Workers Free: `putMany` issues one query per row and an invocation may
 * make 50. `seenAt` is the start of the last sweep that found the target
 * linked; a sweep deletes what it did not stamp, which is how a removed
 * link, an unpublished entry or a deleted one leaves the report.
 */

import type { CheckReason, LinkHistory } from "./check.js";

export type Finding = "broken" | "malformed" | "redirect";

export const FINDINGS: Finding[] = ["broken", "malformed", "redirect"];

/** Places kept on a row; the rest are only counted. */
export const PLACES_KEPT = 3;

/**
 * Ids or values one `IN` list may carry. D1 binds at most 100 parameters
 * per query and emdash's plugin storage adds its own two, without chunking.
 */
export const MAX_IDS = 48;

export interface Place {
	/** The link exactly as written in the entry. */
	url: string;
	/** Dotted path into the entry data, e.g. `body[2].markDefs[0].href`. */
	path: string;
	collection: string;
	entryId: string;
	entrySlug: string | null;
	locale: string | null;
}

export interface CheckRow extends Omit<LinkHistory, "state"> {
	/** `pending` until the target's first check. */
	state: LinkHistory["state"] | "pending";
	/** The URL requested, without its fragment. Also the row id. */
	target: string;
	scope: "internal" | "external";
	reason: CheckReason | null;
	status: number | null;
	location: string | null;
	finalUrl: string | null;
	error: string | null;
	/** `state` once the target is reported, null until then. */
	finding: Finding | null;
	/** Empty until the first check, so a range query finds it as due. */
	checkedAt: string;
	firstSeenAt: string;
	seenAt: string;
	/** The walk page that last stamped the row, so a page read again does not count its places twice. */
	lastPage: string;
	places: Place[];
	placeCount: number;
}

export interface Stored<T> {
	id: string;
	data: T;
}

export function findingFor(verdict: LinkHistory): Finding | null {
	if (!verdict.reported) return null;
	return FINDINGS.find((finding) => finding === verdict.state) ?? null;
}

/** A target nothing has checked yet. */
export function pendingCheck(target: string, scope: CheckRow["scope"], seenAt: string, places: Place[], placeCount: number): CheckRow {
	return {
		target,
		scope,
		state: "pending",
		reason: null,
		status: null,
		location: null,
		finalUrl: null,
		error: null,
		consecutiveFailures: 0,
		firstFailedAt: null,
		reported: false,
		finding: null,
		checkedAt: "",
		firstSeenAt: seenAt,
		seenAt,
		lastPage: "",
		places,
		placeCount,
	};
}
