/**
 * Stored findings: one row per entry that has at least one hit.
 *
 * An entry without hits has no row, so a fixed entry leaves the report as
 * soon as it is evaluated again. `rank` is the entry's most urgent severity
 * and is indexed, which lets the report page through the most urgent rows
 * first instead of sorting whatever the first page happened to hold.
 */

import type { PluginContentItem } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext } from "emdash/plugin";

import { partition, type EntryDismissals } from "./dismissals.js";
import { findingId } from "./ids.js";
import { evaluateEntry, worstRank, type Hit, type Thresholds } from "./rules.js";


export interface EntryFindings {
	collection: string;
	entryId: string;
	slug: string | null;
	/** The entry's `title` field, when it has one, for the report's headings. */
	title: string | null;
	locale: string | null;
	authorId: string | null;
	rank: number;
	hits: Hit[];
	entryUpdatedAt: string;
	/** When the row was written: a sweep's start, or the time of a content hook. */
	seenIn: string;
}


export interface Evaluated {
	writes: Array<{ id: string; data: EntryFindings }>;
	/** Entries evaluated clean, whose rows must go. */
	clears: string[];
}

/**
 * Rows for `entries`, leaving out findings an editor has set aside.
 * `dismissals` is keyed like the rows.
 */
export function evaluateEntries(
	collection: string,
	entries: PluginContentItem[],
	thresholds: Thresholds,
	now: Date,
	seenIn: string,
	dismissals: Map<string, EntryDismissals> = new Map(),
): Evaluated {
	const result: Evaluated = { writes: [], clears: [] };
	for (const entry of entries) {
		const id = findingId(collection, entry.id);
		const hits = partition(evaluateEntry(entry, thresholds, now), dismissals.get(id), now).active;
		if (hits.length === 0) {
			result.clears.push(id);
			continue;
		}
		result.writes.push({
			id,
			data: {
				collection,
				entryId: entry.id,
				slug: entry.slug,
				title: typeof entry.data.title === "string" && entry.data.title.trim() ? entry.data.title.trim() : null,
				locale: entry.locale ?? null,
				authorId: entry.authorId ?? null,
				rank: worstRank(hits),
				hits,
				entryUpdatedAt: entry.updatedAt,
				seenIn,
			},
		});
	}
	return result;
}

/** One `putMany` and one `deleteMany` at most, whatever the number of entries. */
export async function store(ctx: PluginContext, evaluated: Evaluated): Promise<void> {
	if (evaluated.writes.length > 0) await ctx.storage.findings.putMany(evaluated.writes);
	if (evaluated.clears.length > 0) await ctx.storage.findings.deleteMany(evaluated.clears);
}

export interface EntryRef {
	collection: string;
	id: string;
}

/** Remove an entry's row: it was trashed or deleted. */
export async function forget(ctx: PluginContext, ref: EntryRef): Promise<void> {
	await ctx.storage.findings.delete(findingId(ref.collection, ref.id));
}
