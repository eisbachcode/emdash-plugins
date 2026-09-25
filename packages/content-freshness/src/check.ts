/**
 * Checking one entry now, outside the sweep: after a content state change,
 * and whenever its editor panel opens.
 */

import type { PluginContext } from "emdash/plugin";

import {
	dismissalFor,
	isSetAside,
	partition,
	readDismissals,
	writeDismissals,
	type Dismissal,
	type EntryDismissals,
} from "./dismissals.js";
import { evaluateEntries, forget, storeOne, type EntryFindings, type EntryRef } from "./findings.js";
import { findingId } from "./ids.js";
import { evaluateEntry, type Hit, type Rule } from "./rules.js";
import { readSettings, thresholdsFor } from "./settings.js";

export interface PanelAction {
	kind: "set-aside" | "undo";
	rule: Rule;
	by: string | null;
}

export interface PanelView {
	active: Hit[];
	setAside: Array<{ hit: Hit; dismissal: Dismissal }>;
	/** The entry's collection is left out of the audit. */
	skipped?: boolean;
}

/**
 * Apply `action`, check the entry, store its row and return what the panel
 * shows. Four `ctx` calls; one more for a changed row, one more for an
 * action or an expired review.
 */
export async function checkEntry(ctx: PluginContext, ref: EntryRef, action?: PanelAction): Promise<PanelView> {
	if (!ctx.content) return { active: [], setAside: [] };
	const [settings, entry, stored, existing] = await Promise.all([
		readSettings(ctx),
		ctx.content.get(ref.collection, ref.id),
		readDismissals(ctx, ref.collection, ref.id),
		ctx.storage.findings.get(findingId(ref.collection, ref.id)) as Promise<EntryFindings | null>,
	]);
	const thresholds = thresholdsFor(settings, ref.collection);
	if (!entry || thresholds.skip) {
		if (existing) await forget(ctx, ref);
		return { active: [], setAside: [], skipped: thresholds.skip };
	}

	const now = new Date();
	const rules = { ...stored?.rules };
	// Reviews that have run out are dropped whenever the entry is checked.
	let changed = false;
	for (const rule of Object.keys(rules) as Rule[]) {
		if (!isSetAside({ collection: ref.collection, entryId: ref.id, rules }, rule, now)) {
			delete rules[rule];
			changed = true;
		}
	}
	if (action) {
		if (action.kind === "undo") {
			delete rules[action.rule];
		} else {
			const dismissal = dismissalFor(action.rule, thresholds, now, action.by);
			if (dismissal) rules[action.rule] = dismissal;
		}
		changed = true;
	}
	const dismissals: EntryDismissals = { collection: ref.collection, entryId: ref.id, rules };
	if (changed) await writeDismissals(ctx, dismissals);

	const keyed = new Map([[findingId(ref.collection, ref.id), dismissals]]);
	await storeOne(ctx, evaluateEntries(ref.collection, [entry], thresholds, now, now.toISOString(), keyed), existing);
	const { active, setAside } = partition(evaluateEntry(entry, thresholds, now), dismissals, now);
	return { active, setAside: setAside.map((hit) => ({ hit, dismissal: dismissals.rules[hit.rule]! })) };
}

