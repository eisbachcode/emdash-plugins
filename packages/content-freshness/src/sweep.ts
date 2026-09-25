/**
 * One cron tick: audit the next page of the next unfinished collection.
 *
 * Cheaper than the link checker, because evaluation is local — no
 * outbound request per entry. The cost per tick is one `content.list`,
 * one `putMany` and one `deleteMany`, regardless of page size, which
 * matters under the sandbox's 10-subrequest budget (the limit counts
 * service-binding calls, so `ctx.storage` spends from it too).
 */

import { nextCollectionPage, resetCursors } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext } from "emdash/plugin";

import { evaluateEntry, findingId, RULES, type Finding } from "./rules.js";
import type { Settings } from "./settings.js";

export const CURSOR_PREFIX = "state:cursor:";

export interface StoredFinding extends Finding {
	foundAt: string;
}

export interface SweepResult {
	collection: string;
	entries: number;
	found: number;
	/** True when this page finished the last collection. */
	complete: boolean;
}

export async function auditNextPage(
	ctx: PluginContext,
	settings: Settings,
	collections: string[],
): Promise<SweepResult | null> {
	const page = await nextCollectionPage(ctx, collections, CURSOR_PREFIX, settings.pageSize);
	if (!page) return null;

	const now = new Date();
	const writes: Array<{ id: string; data: StoredFinding }> = [];
	const clears: string[] = [];

	for (const entry of page.items) {
		const findings = evaluateEntry(entry, page.collection, settings, now);
		const fired = new Set(findings.map((finding) => finding.rule));

		for (const finding of findings) {
			writes.push({
				id: findingId(page.collection, entry.id, finding.rule),
				data: { ...finding, foundAt: now.toISOString() },
			});
		}

		// A rule that no longer fires had its finding fixed. Clearing the
		// row here is what keeps the report from accumulating history.
		for (const rule of RULES) {
			if (!fired.has(rule)) clears.push(findingId(page.collection, entry.id, rule));
		}
	}

	if (writes.length > 0) await ctx.storage.findings.putMany(writes);
	if (clears.length > 0) await ctx.storage.findings.deleteMany(clears);

	return {
		collection: page.collection,
		entries: page.items.length,
		found: writes.length,
		complete: false,
	};
}

export async function finishSweep(ctx: PluginContext, collections: string[]): Promise<void> {
	await resetCursors(ctx, collections, CURSOR_PREFIX);
	await ctx.kv.set("state:lastSweepFinishedAt", new Date().toISOString());
}
