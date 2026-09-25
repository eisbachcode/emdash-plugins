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
import { subtractMonths, type Hit, type Rule, type Thresholds } from "./rules.js";

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
}

export interface EntryDismissals {
	collection: string;
	entryId: string;
	rules: Partial<Record<Rule, Dismissal>>;
}

export function isSetAside(dismissals: EntryDismissals | undefined, rule: Rule, now: Date): boolean {
	const dismissal = dismissals?.rules[rule];
	if (!dismissal) return false;
	return dismissal.until === null || Date.parse(dismissal.until) > now.getTime();
}

/** `hits` split into those that stand and those set aside. */
export function partition(hits: Hit[], dismissals: EntryDismissals | undefined, now: Date) {
	const active: Hit[] = [];
	const setAside: Hit[] = [];
	for (const hit of hits) (isSetAside(dismissals, hit.rule, now) ? setAside : active).push(hit);
	return { active, setAside };
}

/** A dismissal for `rule`, or null when the rule cannot be set aside. */
export function dismissalFor(rule: Rule, thresholds: Thresholds, now: Date, by: string | null): Dismissal | null {
	const kind = DISMISSIBLE[rule];
	if (!kind) return null;
	if (kind === "ignore") return { until: null, by, at: now.toISOString() };
	if (rule === "unpublished-changes") {
		return { until: new Date(now.getTime() + thresholds.pendingDays * 24 * 60 * 60 * 1000).toISOString(), by, at: now.toISOString() };
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
