import type { ActionsBlock, Block, ButtonElement, SectionBlock, StatsBlock } from "@emdash-cms/blocks";
import { validateBlocks } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, expect, it } from "vitest";

import type { EntryFindings } from "../src/findings.js";
import { VIEW_ACTION } from "../src/report.js";

/**
 * Plugin storage returns at most 100 rows per query. The report once asked
 * for 200 and sorted what came back, so on a site with more than 100
 * findings an urgent one could be missing while the stats counted it.
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
		title: null,
		locale: "en",
		authorId: null,
		rank,
		hits:
			rank === 0
				? [{ rule: "overdue-schedule", severity: "high", params: { date: "2026-09-01", kind: "publish" } }]
				: [{ rule: "stale-draft", severity: "low", params: { since: "2025-01-01" } }],
		entryUpdatedAt: "2025-01-01T00:00:00.000Z",
		seenIn: "2026-09-25T04:00:00.000Z",
	};
}

const sections = (blocks: Block[]) => blocks.filter((block): block is SectionBlock => block.type === "section");
const nextPage = (blocks: Block[]) =>
	blocks
		.filter((block): block is ActionsBlock => block.type === "actions")
		.flatMap((block) => block.elements)
		.find((element): element is ButtonElement => element.type === "button" && element.action_id === VIEW_ACTION && element.label === "Next page");

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
	expect(sections(first.blocks)[0]?.text).toMatch(/^zurgent/);

	const next = nextPage(first.blocks);
	expect(next).toBeDefined();
	const second = await host.admin.act("/report", VIEW_ACTION, { value: next?.value });
	expect(sections(second.blocks).length).toBeGreaterThan(0);
	expect(sections(second.blocks).map((section) => section.text).join()).not.toContain("zurgent");
});

it("falls back to the first page when the row the cursor points at is gone", async () => {
	host = await createPluginRuntimeTestHost();
	for (let i = 0; i < 60; i++) {
		const id = `CUR${String(i).padStart(3, "0")}`;
		await host.fixtures.plugin.storage("findings", `posts:${id}`, row(id, 1));
	}
	const first = await host.admin.loadPage("/report");
	const last = sections(first.blocks).at(-1)?.text.split(" · ")[0] as string;
	// Its entry was fixed or deleted before "Next page".
	await host.transport.invokeHook("content:afterDelete", { id: last.toUpperCase(), collection: "posts", permanent: true });

	const next = await host.admin.act("/report", VIEW_ACTION, { value: nextPage(first.blocks)?.value });

	expect(sections(next.blocks).length).toBeGreaterThan(0);
});
