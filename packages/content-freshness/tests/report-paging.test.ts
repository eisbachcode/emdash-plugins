import type { StatsBlock, TableBlock } from "@emdash-cms/blocks";
import { validateBlocks } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, expect, it } from "vitest";

import type { EntryFindings } from "../src/findings.js";
import { PAGE_ACTION } from "../src/report.js";

/**
 * Plugin storage returns at most 100 rows per query. The report used to ask
 * for 200 and sort what came back, so on a site with more than 100 findings
 * an urgent one could be missing from the table while the stats counted it.
 * Alone in this file because plugin storage outlives a host within a file.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

function row(entryId: string, rank: number): EntryFindings {
	return {
		collection: "posts",
		entryId,
		slug: entryId.toLowerCase(),
		locale: "en",
		rank,
		hits:
			rank === 0
				? [{ rule: "overdue-schedule", severity: "high", params: { date: "2026-09-01", kind: "publish", status: "draft" } }]
				: [{ rule: "stale-draft", severity: "low", params: { since: "2025-01-01" } }],
		entryUpdatedAt: "2025-01-01T00:00:00.000Z",
		seenIn: "2026-09-25T04:00:00.000Z",
	};
}

it("opens with the most urgent entries however many findings there are", async () => {
	host = await createPluginRuntimeTestHost();
	for (let i = 0; i < 100; i++) {
		const id = `LOW${String(i).padStart(3, "0")}`;
		await host.fixtures.plugin.storage("findings", `posts:${id}`, row(id, 2));
	}
	await host.fixtures.plugin.storage("findings", "posts:ZURGENT", row("ZURGENT", 0));

	const first = await host.admin.loadPage("/report");
	expect(validateBlocks(first.blocks).valid).toBe(true);
	const stats = first.blocks.find((block): block is StatsBlock => block.type === "stats");
	expect(stats?.items.map((item) => item.value)).toEqual([1, 0, 100, 101]);
	const table = first.blocks.find((block): block is TableBlock => block.type === "table");
	expect(table?.rows[0]).toMatchObject({ entry: "zurgent", priority: "Urgent" });
	expect(table?.next_cursor).toBeTruthy();

	const second = await host.admin.act("/report", PAGE_ACTION, { value: { cursor: table?.next_cursor } });
	const next = second.blocks.find((block): block is TableBlock => block.type === "table");
	expect(next?.rows.length).toBeGreaterThan(0);
	expect(next?.rows.map((r) => r.entry)).not.toContain("zurgent");
});

it("falls back to the first page when the row the cursor points at is gone", async () => {
	host = await createPluginRuntimeTestHost();
	for (let i = 0; i < 60; i++) {
		const id = `CUR${String(i).padStart(3, "0")}`;
		await host.fixtures.plugin.storage("findings", `posts:${id}`, row(id, 1));
	}
	const first = await host.admin.loadPage("/report");
	const table = first.blocks.find((block): block is TableBlock => block.type === "table");
	const last = table?.rows.at(-1)?.entry as string;
	// Its entry was fixed or deleted before "Load more".
	await host.transport.invokeHook("content:afterDelete", { id: last.toUpperCase(), collection: "posts", permanent: true });

	const next = await host.admin.act("/report", PAGE_ACTION, { value: { cursor: table?.next_cursor } });

	const rows = next.blocks.find((block): block is TableBlock => block.type === "table")?.rows ?? [];
	expect(rows.length).toBeGreaterThan(0);
});
