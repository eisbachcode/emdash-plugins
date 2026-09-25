/**
 * Keeping one entry's row current between sweeps.
 *
 * Publishing, unpublishing, scheduling and restoring re-evaluate the entry;
 * trashing or deleting it removes its row. `content:afterSave` is left out
 * on purpose: it also fires for every autosave, which for a sandboxed
 * install would start an isolate every few seconds while someone types.
 * A save without a state change is picked up when the entry's Freshness
 * panel opens, or by the next sweep.
 */

import type { EntryRef } from "./findings.js";

/** The entry a state-change event is about: `{ content, collection }`, with the id on `content`. */
export function changedEntry(event: unknown): EntryRef | null {
	if (typeof event !== "object" || event === null) return null;
	const { content, collection } = event as { content?: unknown; collection?: unknown };
	if (typeof collection !== "string" || typeof content !== "object" || content === null) return null;
	const id = (content as { id?: unknown }).id;
	return typeof id === "string" ? { collection, id } : null;
}

/** The entry a delete event is about, `{ id, collection, permanent }`, and whether it is gone for good. */
export function deletedEntry(event: unknown): (EntryRef & { permanent: boolean }) | null {
	if (typeof event !== "object" || event === null) return null;
	const { id, collection, permanent } = event as { id?: unknown; collection?: unknown; permanent?: unknown };
	return typeof id === "string" && typeof collection === "string"
		? { collection, id, permanent: permanent === true }
		: null;
}
