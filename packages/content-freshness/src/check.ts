/**
 * Checking one entry now, outside the sweep: after a content state change,
 * and whenever its editor panel opens.
 */

import type { PluginContext } from "emdash/plugin";

import {
	dismissalFor,
	hasRunOut,
	partition,
	readDismissals,
	writeDismissals,
	type Dismissal,
	type EntryDismissals,
} from "./dismissals.js";
import { evaluateEntries, forget, storeOne, type EntryFindings, type EntryRef } from "./findings.js";
import { findingId } from "./ids.js";
import { datetimeFields, evaluateEntry, type Hit, type Rule } from "./rules.js";
import { contextFor, readSettings, thresholdsFor } from "./settings.js";

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
 * shows. Five `ctx` calls; one more for a changed row, one more for an
 * action or an expired review.
 */
export async function checkEntry(ctx: PluginContext, ref: EntryRef, action?: PanelAction): Promise<PanelView> {
	if (!ctx.content) return { active: [], setAside: [] };
	const [settings, entry, stored, existing, schema] = await Promise.all([
		readSettings(ctx),
		ctx.content.get(ref.collection, ref.id),
		readDismissals(ctx, ref.collection, ref.id),
		ctx.storage.findings.get(findingId(ref.collection, ref.id)) as Promise<EntryFindings | null>,
		ctx.schema ? ctx.schema.getCollection(ref.collection) : Promise.resolve(null),
	]);
	const thresholds = thresholdsFor(settings, ref.collection);
	if (!entry || thresholds.skip) {
		if (existing) await forget(ctx, ref);
		return { active: [], setAside: [], skipped: thresholds.skip };
	}

	const now = new Date();
	const context = contextFor(
		settings,
		ref.collection,
		schema ? { dateFields: datetimeFields(schema.fields), revisions: schema.supports.includes("revisions") } : undefined,
	);
	const hits = evaluateEntry(entry, thresholds, now, context);

	const rules = { ...stored?.rules };
	// Reviews that have run out are dropped whenever the entry is checked.
	let changed = false;
	for (const [rule, dismissal] of Object.entries(rules) as Array<[Rule, Dismissal]>) {
		if (hasRunOut(dismissal, now)) {
			delete rules[rule];
			changed = true;
		}
	}
	if (action) {
		if (action.kind === "undo") {
			delete rules[action.rule];
		} else {
			const hit = hits.find((candidate) => candidate.rule === action.rule);
			const dismissal = dismissalFor(action.rule, thresholds, now, action.by, hit);
			if (dismissal) rules[action.rule] = dismissal;
		}
		changed = true;
	}
	const dismissals: EntryDismissals = { collection: ref.collection, entryId: ref.id, rules };
	if (changed) await writeDismissals(ctx, dismissals);

	const keyed = new Map([[findingId(ref.collection, ref.id), dismissals]]);
	const evaluated = evaluateEntries(ref.collection, [entry], thresholds, now, now.toISOString(), keyed, context);
	await storeOne(ctx, evaluated, existing);
	const { active, setAside } = partition(hits, dismissals, now);
	return { active, setAside: setAside.map((hit) => ({ hit, dismissal: dismissals.rules[hit.rule]! })) };
}

