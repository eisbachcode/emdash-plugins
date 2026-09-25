/**
 * Checking one entry now, outside the sweep: after a content state change,
 * and whenever its editor panel opens.
 */

import type { PluginContext } from "emdash/plugin";

import {
	dismissalFor,
	partition,
	readDismissals,
	writeDismissals,
	type Dismissal,
	type EntryDismissals,
} from "./dismissals.js";
import { evaluateEntries, forget, store, type EntryRef } from "./findings.js";
import { findingId } from "./ids.js";
import { evaluateEntry, type Hit, type Rule } from "./rules.js";
import { readSettings } from "./settings.js";

export interface PanelAction {
	kind: "set-aside" | "undo";
	rule: Rule;
	by: string | null;
}

export interface PanelView {
	active: Hit[];
	setAside: Array<{ hit: Hit; dismissal: Dismissal }>;
}

/**
 * Apply `action`, check the entry, store its row and return what the panel
 * shows. Four `ctx` calls, five with an action.
 */
export async function checkEntry(ctx: PluginContext, ref: EntryRef, action?: PanelAction): Promise<PanelView> {
	if (!ctx.content) return { active: [], setAside: [] };
	const [settings, entry, stored] = await Promise.all([
		readSettings(ctx),
		ctx.content.get(ref.collection, ref.id),
		readDismissals(ctx, ref.collection, ref.id),
	]);
	if (!entry) {
		await forget(ctx, ref);
		return { active: [], setAside: [] };
	}

	const now = new Date();
	let dismissals: EntryDismissals = stored ?? { collection: ref.collection, entryId: ref.id, rules: {} };
	if (action) {
		const rules = { ...dismissals.rules };
		if (action.kind === "undo") {
			delete rules[action.rule];
		} else {
			const dismissal = dismissalFor(action.rule, settings, now, action.by);
			if (dismissal) rules[action.rule] = dismissal;
		}
		dismissals = { ...dismissals, rules };
		await writeDismissals(ctx, dismissals);
	}

	const keyed = new Map([[findingId(ref.collection, ref.id), dismissals]]);
	await store(ctx, evaluateEntries(ref.collection, [entry], settings, now, now.toISOString(), keyed));
	const { active, setAside } = partition(evaluateEntry(entry, settings, now), dismissals, now);
	return { active, setAside: setAside.map((hit) => ({ hit, dismissal: dismissals.rules[hit.rule]! })) };
}

