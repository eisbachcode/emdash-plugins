import { validateBlockResponse } from "@emdash-cms/blocks/server";
import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EntryRow } from "../src/store/rows.js";
import { CONTENT_PATH } from "../src/ui/content.js";
import { PAGE_PATH } from "../src/ui/page.js";
import { PANEL_ID, renderPanel } from "../src/ui/panel.js";
import { bridgeCalls } from "./bridge-calls.js";
import { newHost, NOW, routableCollection, setState, synced } from "./host.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

type AnyBlock = Record<string, unknown> & { type: string };

function find(blocks: unknown, type: string): AnyBlock[] {
	const out: AnyBlock[] = [];
	const walk = (value: unknown) => {
		if (Array.isArray(value)) value.forEach(walk);
		else if (value && typeof value === "object") {
			const record = value as AnyBlock;
			if (record.type === type) out.push(record);
			Object.values(record).forEach(walk);
		}
	};
	walk(blocks);
	return out;
}

const row = (path: string, over: Partial<EntryRow> = {}): EntryRow => ({
	path,
	collection: "posts",
	entryId: `id${path}`,
	translationGroup: `id${path}`,
	locale: "en",
	title: path,
	status: "published",
	views7: 0,
	views30: 0,
	updatedAt: NOW.toISOString(),
	...over,
});

async function put(runtime: PluginRuntimeTestHost, data: EntryRow) {
	await runtime.fixtures.plugin.storage("entries", data.path, data);
}

const stat = (blocks: unknown) =>
	(find(blocks, "stats")[0]?.items as Array<{ label: string; value: string }> | undefined)?.map((i) => [i.label, i.value]);

describe("renderPanel", () => {
	it("produces blocks the host accepts", () => {
		const current = row("/de/a/", { locale: "de", translationGroup: "a", views7: 3, views30: 30 });
		const other = row("/en/a/", { locale: "en", translationGroup: "a", views7: 1, views30: 12 });
		const blocks = renderPanel({ current, members: [current, other], state: synced, now: NOW, locale: "en" });
		const result = validateBlockResponse({ blocks }, { pluginPagePaths: [PAGE_PATH, CONTENT_PATH] });
		expect(result.errors).toEqual([]);
	});
});

describe("the Views panel", () => {
	it("shows the entry's own numbers", async () => {
		host = await newHost();
		const [id] = await routableCollection(host, 1);
		await put(host, row("/blog/post-0/", { entryId: id!, views7: 4, views30: 19 }));
		await setState(host, synced);

		const response = await host.admin.loadEditorPanel(PANEL_ID, "posts", id!);

		expect(stat(response.blocks)).toEqual([
			["Page views, last 7 days", "4"],
			["Page views, last 30 days", "19"],
		]);
		expect(find(response.blocks, "context")[0]!.text).toContain("/blog/post-0/");
	});

	it("adds the translations and their total", async () => {
		host = await newHost();
		const [id] = await routableCollection(host, 1);
		await put(host, row("/blog/post-0/", { entryId: id!, translationGroup: id!, views30: 30 }));
		await put(host, row("/en/blog/post-0/", { entryId: "other", translationGroup: id!, locale: "de", views30: 12 }));
		await put(host, row("/fr/blog/post-0/", { entryId: "gone", translationGroup: id!, locale: "fr", views30: 99, status: "deleted" }));
		await setState(host, synced);

		const response = await host.admin.loadEditorPanel(PANEL_ID, "posts", id!);

		// Two cards only; the total sits in the context line.
		expect(stat(response.blocks)).toHaveLength(2);
		expect(find(response.blocks, "context")[0]!.text).toContain("All languages: 42 in 30 days");
		const rows = find(response.blocks, "table")[0]!.rows as Array<Record<string, unknown>>;
		expect(rows.map((r) => [r.language, r.views30])).toEqual([
			["en", 30],
			["de", 12],
		]);
	});

	it("says why there are no numbers for an entry without a page", async () => {
		host = await newHost();
		const [id] = await routableCollection(host, 1);
		await setState(host, synced);

		const response = await host.admin.loadEditorPanel(PANEL_ID, "posts", id!);

		expect(find(response.blocks, "empty")[0]).toMatchObject({ title: "No page for this entry yet" });
	});

	it("opens for an author on their own entry", async () => {
		// The analytics pages need plugins:read (EDITOR). The panel is the one
		// place an author sees their own numbers.
		host = await newHost();
		await routableCollection(host, 0);
		const author = await host.fixtures.user({ email: "author@example.test", role: "author" });
		const item = await host.fixtures.content("posts", {
			slug: "mine",
			data: { title: "Mine" },
			status: "published",
			publishedAt: NOW.toISOString(),
			authorId: author.id,
		});
		await put(host, row("/blog/mine/", { entryId: item.id, views30: 8 }));
		await setState(host, synced);

		const response = await host.admin.loadEditorPanel(PANEL_ID, "posts", item.id, { user: author });

		expect(stat(response.blocks)?.[1]).toEqual(["Page views, last 30 days", "8"]);
	});

	it("stays inside the call budget", async () => {
		host = await newHost();
		const [id] = await routableCollection(host, 1);
		await put(host, row("/blog/post-0/", { entryId: id!, translationGroup: id! }));
		await put(host, row("/de/blog/post-0/", { entryId: "other", translationGroup: id!, locale: "de" }));
		await setState(host, synced);

		const calls = await bridgeCalls(() => host!.admin.loadEditorPanel(PANEL_ID, "posts", id!));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(10);
		expect(calls.filter((c) => c === "storageQuery")).toHaveLength(2);
	});
});
