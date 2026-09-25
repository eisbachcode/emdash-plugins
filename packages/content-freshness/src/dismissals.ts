/**
 * Findings an editor has set aside: one document per entry, under the same
 * key as its finding row, so a page of entries needs one `getMany`.
 *
 * "Mark as reviewed" holds a time-based finding back until the threshold has
 * run out again: an imprint that is still correct should not be edited just
 * to make the report quiet. "Ignore" holds a description finding, or an
 * expiry on a page kept online as an archive, back for good. A missed
 * schedule cannot be set aside.
 */

import type { PluginContext } from "emdash/plugin";

import { findingId } from "./ids.js";
import { DAY_MS, subtractMonths, type Hit, type Rule, type Thresholds } from "./rules.js";

export type DismissKind = "review" | "ignore";

export const DISMISSIBLE: Partial<Record<Rule, DismissKind>> = {
	stale: "review",
	"stale-draft": "review",
	"missing-description": "ignore",
	"description-length": "ignore",
	"unpublished-changes": "review",
	"expired": "ignore",
};

export interface Dismissal {
	/** When the finding may come back; `null` for never. */
	until: string | null;
	by: string | null;
	at: string;
	/**
	 * What exactly was set aside, for a finding that can recur with other
	 * values: an ignored expiry names its date, so moving the date forward
	 * and letting it pass again is reported.
	 */
	subject?: string;
}

export interface EntryDismissals {
	collection: string;
	entryId: string;
	rules: Partial<Record<Rule, Dismissal>>;
}

/** The part of a hit a dismissal must match, for rules whose finding can recur with other values. */
function subjectOf(hit: Hit): string | undefined {
	return hit.rule === "expired" ? String(hit.params.date) : undefined;
}

export function hasRunOut(dismissal: Dismissal, now: Date): boolean {
	return dismissal.until !== null && Date.parse(dismissal.until) <= now.getTime();
}

export function isSetAside(dismissals: EntryDismissals | undefined, hit: Hit, now: Date): boolean {
	const dismissal = dismissals?.rules[hit.rule];
	if (!dismissal || hasRunOut(dismissal, now)) return false;
	return dismissal.subject === undefined || dismissal.subject === subjectOf(hit);
}

/** `hits` split into those that stand and those set aside. */
export function partition(hits: Hit[], dismissals: EntryDismissals | undefined, now: Date) {
	const active: Hit[] = [];
	const setAside: Hit[] = [];
	for (const hit of hits) (isSetAside(dismissals, hit, now) ? setAside : active).push(hit);
	return { active, setAside };
}

/** A dismissal for `rule`, or null when the rule cannot be set aside. `hit` is the finding being set aside. */
export function dismissalFor(
	rule: Rule,
	thresholds: Thresholds,
	now: Date,
	by: string | null,
	hit?: Hit,
): Dismissal | null {
	const kind = DISMISSIBLE[rule];
	if (!kind) return null;
	if (kind === "ignore") {
		const subject = hit ? subjectOf(hit) : undefined;
		return { until: null, by, at: now.toISOString(), ...(subject !== undefined ? { subject } : {}) };
	}
	if (rule === "unpublished-changes") {
		return { until: new Date(now.getTime() + thresholds.pendingDays * DAY_MS).toISOString(), by, at: now.toISOString() };
	}
	const months = rule === "stale" ? thresholds.staleMonths : thresholds.draftMonths;
	return { until: subtractMonths(now, -months).toISOString(), by, at: now.toISOString() };
}

export async function readDismissals(
	ctx: PluginContext,
	collection: string,
	entryId: string,
): Promise<EntryDismissals | undefined> {
	return ((await ctx.storage.dismissals.get(findingId(collection, entryId))) ?? undefined) as
		| EntryDismissals
		| undefined;
}

/** Write `dismissals`, or remove the document once nothing is set aside. */
export async function writeDismissals(ctx: PluginContext, dismissals: EntryDismissals): Promise<void> {
	const id = findingId(dismissals.collection, dismissals.entryId);
	if (Object.keys(dismissals.rules).length === 0) await ctx.storage.dismissals.delete(id);
	else await ctx.storage.dismissals.put(id, dismissals);
}
