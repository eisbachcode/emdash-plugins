import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EntryRow } from "../src/store/rows.js";
import type { SyncState } from "../src/sync/scheduler.js";
import { CONTENT_PATH, REBUILD_ACTION, viewAction, DEFAULT_VIEW } from "../src/ui/content.js";
import { bridgeCalls } from "./bridge-calls.js";
import { newHost, NOW, pathsOf, routableCollection, setState, synced } from "./host.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const LIMIT = 10;

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

function tableOf(response: { blocks?: unknown }) {
	const table = find(response.blocks, "table")[0];
	if (!table) throw new Error("no table");
	return {
		actionId: String(table.page_action_id),
		next: table.next_cursor as string | undefined,
		rows: table.rows as Array<Record<string, unknown>>,
	};
}

async function put(runtime: PluginRuntimeTestHost, path: string, over: Partial<EntryRow> = {}) {
	await runtime.fixtures.plugin.storage("entries", path, {
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
}

const load = (runtime: PluginRuntimeTestHost) => runtime.admin.loadPage(CONTENT_PATH);
const act = (runtime: PluginRuntimeTestHost, actionId: string, value?: unknown) =>
	runtime.admin.act(CONTENT_PATH, actionId, value === undefined ? {} : { value });

describe("the per-entry page", () => {
	it("lists every published entry, the unviewed ones last, and leaves out unpublished ones", async () => {
		host = await newHost();
		await routableCollection(host, 0);
		await put(host, "/a/", { views30: 9 });
		await put(host, "/b/", { views30: 0 });
		await put(host, "/c/", { views30: 4 });
		await put(host, "/gone/", { views30: 50, status: "unpublished" });
		await setState(host, synced);

		const { rows } = tableOf(await load(host));

		expect(rows.map((r) => [r.path, r.views30])).toEqual([
			["/a/", 9],
			["/c/", 4],
			["/b/", 0],
		]);
	});

	it("sorts on a header click, in storage", async () => {
		host = await newHost();
		await routableCollection(host, 0);
		await put(host, "/a/", { views7: 1, views30: 9 });
		await put(host, "/b/", { views7: 7, views30: 7 });
		await setState(host, synced);

		const first = tableOf(await load(host));
		const sorted = tableOf(await act(host, first.actionId, { sort: { key: "views7", dir: "desc" } }));

		expect(sorted.rows.map((r) => r.path)).toEqual(["/b/", "/a/"]);
	});

	it("pages through more entries than one table holds", async () => {
		host = await newHost();
		await routableCollection(host, 0);
		const paths = pathsOf(60);
		for (const [i, path] of paths.entries()) await put(host, path, { views30: 100 - i });
		// Kept for history, not shown, and not counted in "Entries 51 to 60".
		await put(host, "/hidden/", { views30: 99, status: "unpublished" });
		await setState(host, synced);

		const first = tableOf(await load(host));
		expect(first.rows).toHaveLength(49);
		expect(first.next).toBeTruthy();

		const second = await act(host, first.actionId, { cursor: first.next, sort: null });
		const rest = tableOf(second);
		expect(rest.rows.map((r) => r.path)).toEqual(paths.slice(49));
		expect(rest.next).toBeUndefined();
		expect(find(second.blocks, "context").map((b) => b.text).join(" ")).toContain("Entries 50 to 60.");
	});

	it("narrows to one collection", async () => {
		host = await newHost();
		await routableCollection(host, 0);
		await put(host, "/blog/a/", { views30: 1 });
		await put(host, "/about/", { collection: "pages", views30: 5 });
		await setState(host, synced);

		const { rows } = tableOf(
			await act(host, viewAction({ ...DEFAULT_VIEW, collection: "posts" })),
		);

		expect(rows.map((r) => r.path)).toEqual(["/blog/a/"]);
	});

	it("treats a site with one content language as monolingual, whatever the site locale", async () => {
		// The host reports "en"; every entry here is German and untranslated.
		host = await newHost();
		await routableCollection(host, 0);
		await put(host, "/", { locale: "de", views30: 3 });
		await put(host, "/kontakt/", { locale: "de", views30: 1 });
		await setState(host, synced);

		const response = await load(host);

		const columns = (find(response.blocks, "table")[0]!.columns as Array<{ key: string }>).map((c) => c.key);
		expect(columns).not.toContain("language");
		expect(find(response.blocks, "button").map((b) => b.label)).not.toContain("Languages combined");
	});

	it("totals each entry's translations, and combines them on request", async () => {
		host = await newHost();
		await routableCollection(host, 0);
		await put(host, "/de/a/", { locale: "de", translationGroup: "a", views30: 30, views7: 3 });
		await put(host, "/en/a/", { locale: "en", translationGroup: "a", views30: 12, views7: 1 });
		await put(host, "/en/b/", { locale: "en", translationGroup: "b", views30: 35, views7: 9 });
		await setState(host, synced);

		const each = tableOf(await load(host));
		expect(each.rows.map((r) => [r.path, r.views30, r.allLanguages])).toEqual([
			["/en/b/", 35, 35],
			["/de/a/", 30, 42],
			["/en/a/", 12, 42],
		]);

		const combined = tableOf(await act(host, viewAction({ ...DEFAULT_VIEW, mode: "combined" })));
		expect(combined.rows.map((r) => [r.views30, r.byLanguage])).toEqual([
			[42, "de 30 · en 12"],
			[35, "en 35"],
		]);
	});

	it("stores the collection labels for the analytics page, once", async () => {
		host = await newHost();
		await routableCollection(host, 0);
		await put(host, "/a/", { views30: 1 });
		await setState(host, synced);

		const first = await bridgeCalls(() => load(host!));
		expect((await host.inspect.kv.get<SyncState>("state"))?.collectionLabels).toEqual({ posts: "Posts" });
		expect(first).toContain("kvSet");

		// Unchanged labels cost nothing on the next load.
		const second = await bridgeCalls(() => load(host!));
		expect(second).not.toContain("kvSet");
	});

	it("asks for a rebuild and says so", async () => {
		host = await newHost();
		await routableCollection(host, 0);
		await setState(host, synced);

		const response = await act(host, `${REBUILD_ACTION}|`);

		expect(response.toast).toMatchObject({ type: "success" });
		expect((await host.inspect.kv.get<SyncState>("state"))?.rebuild).toBe(true);
		expect(find(response.blocks, "context").map((b) => b.text).join(" ")).toContain("Rebuilding the content index");
	});
});

describe("the per-entry page's bridge calls", () => {
	async function manyTranslated(runtime: PluginRuntimeTestHost, groups: number) {
		await routableCollection(runtime, 0);
		for (let i = 0; i < groups; i++) {
			for (const locale of ["de", "en", "fr"]) {
				const path = `/${locale}/p-${String(i).padStart(3, "0")}/`;
				await put(runtime, path, { locale, translationGroup: `g${i}`, views30: i, views7: i });
			}
		}
		await runtime.fixtures.plugin.storage("daily", `2026-09-01|/de/p-000/`, {
			date: "2026-09-01",
			path: "/de/p-000/",
			pageviews: 1,
			visits: 1,
			sampleInterval: 1,
			fetchedAt: NOW.toISOString(),
		});
		await setState(runtime, synced);
	}

	it("a load in each-language mode, translations totalled", async () => {
		host = await newHost();
		await manyTranslated(host, 40);
		const calls = await bridgeCalls(() => load(host!));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls.filter((c) => c === "storageQuery").length).toBeGreaterThanOrEqual(3);
	});

	it("a load in combined mode with more entries than it reads", async () => {
		host = await newHost();
		await manyTranslated(host, 110);
		const calls = await bridgeCalls(() => act(host!, viewAction({ ...DEFAULT_VIEW, mode: "combined" })));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls.filter((c) => c === "storageQuery").length).toBeGreaterThanOrEqual(4);
	});

	it("a rebuild request", async () => {
		host = await newHost();
		await manyTranslated(host, 40);
		const calls = await bridgeCalls(() => act(host!, `${REBUILD_ACTION}|`));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("kvSet");
	});
});
