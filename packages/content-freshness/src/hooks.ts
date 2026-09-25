/**
 * Keeping one entry's row current between sweeps.
 *
 * Publishing, unpublishing, scheduling and restoring re-evaluate the entry;
 * trashing or deleting it removes its row. `content:afterSave` is left out
 * on purpose: it also fires for every autosave, which for a sandboxed
 * install would start an isolate every few seconds while someone types.
 * A save without a state change is picked up by the next sweep.
 */

import type { PluginContext } from "emdash/plugin";

import { evaluateEntries, findingId, store } from "./findings.js";
import { readSettings } from "./settings.js";

interface EntryRef {
	collection: string;
	id: string;
}

/** The entry a state-change event is about: `{ content, collection }`, with the id on `content`. */
export function changedEntry(event: unknown): EntryRef | null {
	if (typeof event !== "object" || event === null) return null;
	const { content, collection } = event as { content?: unknown; collection?: unknown };
	if (typeof collection !== "string" || typeof content !== "object" || content === null) return null;
	const id = (content as { id?: unknown }).id;
	return typeof id === "string" ? { collection, id } : null;
}

/** The entry a delete event is about: `{ id, collection }`. */
export function deletedEntry(event: unknown): EntryRef | null {
	if (typeof event !== "object" || event === null) return null;
	const { id, collection } = event as { id?: unknown; collection?: unknown };
	return typeof id === "string" && typeof collection === "string" ? { collection, id } : null;
}

/** Evaluate one entry now and store the result. Three `ctx` calls. */
export async function reevaluate(ctx: PluginContext, ref: EntryRef): Promise<void> {
	if (!ctx.content) return;
	const [settings, entry] = await Promise.all([readSettings(ctx), ctx.content.get(ref.collection, ref.id)]);
	if (!entry) {
		await forget(ctx, ref);
		return;
	}
	const now = new Date();
	await store(ctx, evaluateEntries(ref.collection, [entry], settings, now, now.toISOString()));
}

export async function forget(ctx: PluginContext, ref: EntryRef): Promise<void> {
	await ctx.storage.findings.delete(findingId(ref.collection, ref.id));
}
