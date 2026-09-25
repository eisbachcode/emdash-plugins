import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { EntryRow } from "../src/store/rows.js";
import { parseListInput, TOOL_ROUTES } from "../src/tools/load.js";
import { addDays } from "../src/sync/window.js";
import { daysBack, newHost, NOW, seedDaily, seedRollup, setState, synced, TODAY } from "./host.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

interface ManifestTool {
	name: string;
	route: string;
	permission: string;
	destructive: boolean;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
}

function toolsOf(runtime: PluginRuntimeTestHost): ManifestTool[] {
	return (runtime.manifest as unknown as { mcp?: { tools: ManifestTool[] } }).mcp?.tools ?? [];
}

/**
 * Call a tool's route and hold the answer against the output schema the
 * build wrote, converted the way EmDash converts it for a sandboxed
 * install. The MCP server rejects an answer that does not match, so a
 * loader that drifts from its declaration breaks the tool, not just a type.
 */
async function call(runtime: PluginRuntimeTestHost, route: string, input: Record<string, unknown> = {}) {
	const tool = toolsOf(runtime).find((t) => t.route === route);
	if (!tool?.outputSchema) throw new Error(`no tool with an output schema calls ${route}`);
	const result = await runtime.transport.invokeRoute(route, input);
	const parsed = z.fromJSONSchema({ ...tool.outputSchema }).safeParse(result);
	expect(parsed.error?.issues ?? []).toEqual([]);
	return result as Record<string, any>;
}

const row = (path: string, over: Partial<EntryRow> = {}): EntryRow => ({
	path,
	collection: "posts",
	entryId: `id${path}`,
	translationGroup: `id${path}`,
	locale: "en",
	title: `Title ${path}`,
	status: "published",
	views7: 0,
	views30: 0,
	updatedAt: NOW.toISOString(),
	...over,
});

async function put(runtime: PluginRuntimeTestHost, ...rows: EntryRow[]) {
	for (const data of rows) await runtime.fixtures.plugin.storage("entries", data.path, data);
}

describe("the manifest's MCP tools", () => {
	it("each call a private route with the permission the tool declares", async () => {
		// EmDash skips a tool whose route is missing, public or has another
		// permission, without an error anywhere.
		host = await newHost();
		const manifest = host.manifest as unknown as {
			routes?: Array<string | { name: string; permission?: string; public?: boolean }>;
		};
		const routes = new Map(
			(manifest.routes ?? []).map((r) => (typeof r === "string" ? [r, { name: r }] : [r.name, r])),
		);
		const tools = toolsOf(host);

		expect(tools.length).toBeGreaterThan(0);
		for (const tool of tools) {
			const route = routes.get(tool.route) as { permission?: string; public?: boolean } | undefined;
			expect(route, tool.name).toBeDefined();
			expect(route!.public, tool.name).not.toBe(true);
			expect(route!.permission, tool.name).toBe(tool.permission);
		}
	});
});

describe("top_entries", () => {
	async function seeded() {
		const runtime = await newHost();
		await put(
			runtime,
			row("/a/", { views7: 5, views30: 50 }),
			row("/b/", { views7: 20, views30: 30 }),
			row("/c/", { views7: 90, views30: 99, status: "unpublished" }),
			row("/d/", { collection: "pages", views7: 0, views30: 10, publishedAt: "2026-09-01T08:00:00.000Z" }),
		);
		await setState(runtime, { ...synced, collectionLabels: { posts: "Posts", pages: "Pages" } });
		return runtime;
	}

	it("lists published entries by views in the window, most viewed first", async () => {
		host = await seeded();

		const thirty = await call(host, TOOL_ROUTES.topEntries, { days: 30 });
		expect(thirty.items.map((i: { path: string; views: number }) => [i.path, i.views])).toEqual([
			["/a/", 50],
			["/b/", 30],
			["/d/", 10],
		]);
		expect(thirty.window).toMatchObject({ days: 30, since: addDays(TODAY, -29), until: TODAY });
		expect(thirty.items[2]).toMatchObject({ collectionLabel: "Pages", publishedAt: "2026-09-01T08:00:00.000Z" });

		const seven = await call(host, TOOL_ROUTES.topEntries, { days: 7 });
		expect(seven.items.map((i: { path: string }) => i.path)).toEqual(["/b/", "/a/", "/d/"]);
	});

	it("filters by collection and pages with the cursor", async () => {
		host = await seeded();

		const pages = await call(host, TOOL_ROUTES.topEntries, { collection: "pages" });
		expect(pages.items.map((i: { path: string }) => i.path)).toEqual(["/d/"]);
		expect(pages.collection).toBe("pages");

		const first = await call(host, TOOL_ROUTES.topEntries, { limit: 2 });
		expect(first.items.map((i: { path: string }) => i.path)).toEqual(["/a/", "/b/"]);
		const second = await call(host, TOOL_ROUTES.topEntries, { limit: 2, cursor: first.nextCursor });
		expect(second.items.map((i: { path: string }) => i.path)).toEqual(["/d/"]);
		expect(second.nextCursor).toBeUndefined();
	});

	it("fills a page past entries that are no longer published", async () => {
		// The most viewed row is an unpublished entry's; "top 1" must still
		// name one.
		host = await seeded();

		const result = await call(host, TOOL_ROUTES.topEntries, { limit: 1 });

		expect(result.items.map((i: { path: string }) => i.path)).toEqual(["/a/"]);
		expect(result.nextCursor).toEqual(expect.any(String));
	});

	it("pages through every published entry once, in order, past rows kept for history", async () => {
		host = await newHost();
		const published: string[] = [];
		for (let i = 0; i < 40; i++) {
			const path = `/e-${String(i).padStart(2, "0")}/`;
			const kept = i % 3 === 1;
			await put(host, row(path, { views30: 100 - i, ...(kept && { status: "moved" as const }) }));
			if (!kept) published.push(path);
		}
		await setState(host, synced);

		const seen: string[] = [];
		let cursor: string | undefined;
		for (let calls = 0; calls < 20; calls++) {
			const page = await call(host, TOOL_ROUTES.topEntries, { limit: 4, ...(cursor && { cursor }) });
			seen.push(...page.items.map((i: { path: string }) => i.path));
			cursor = page.nextCursor;
			if (!cursor) break;
		}

		expect(seen).toEqual(published);
	});

	it("refuses a cursor from another window, collection or tool", async () => {
		// A storage cursor seeks by the sorted column's value; used with
		// another order it would skip or repeat entries silently. Checked at
		// the parser: a route that throws trips the test host's hang detector.
		host = await seeded();
		const { nextCursor: cursor } = await call(host, TOOL_ROUTES.topEntries, { days: 30, limit: 1 });

		expect(parseListInput("top", { days: 30, cursor }).cursor).toEqual(expect.any(String));
		expect(() => parseListInput("top", { days: 7, cursor })).toThrow(/another query/);
		expect(() => parseListInput("top", { days: 30, collection: "posts", cursor })).toThrow(/another query/);
		expect(() => parseListInput("unviewed", { days: 30, cursor })).toThrow(/another query/);
		expect(() => parseListInput("top", { days: 30, cursor: "garbage" })).toThrow(/another query/);
	});

	it("says when stored history is shorter than the window", async () => {
		host = await seeded();
		await seedDaily(host, ["/a/"], daysBack(10));

		const seven = await call(host, TOOL_ROUTES.topEntries, { days: 7 });
		const thirty = await call(host, TOOL_ROUTES.topEntries, { days: 30 });

		expect(seven.historySince).toBe(addDays(TODAY, -9));
		expect(seven.window.partial).toBe(false);
		expect(thirty.window.partial).toBe(true);
	});

	it("falls back to the defaults for input nothing validated", async () => {
		// Over HTTP the route gets whatever the caller sent.
		host = await seeded();

		const result = await call(host, TOOL_ROUTES.topEntries, { days: 90, limit: 500, collection: "No Slug" });

		expect(result.window.days).toBe(30);
		expect(result.collection).toBeNull();
		expect(result.items).toHaveLength(3);
	});
});

describe("unviewed_entries", () => {
	it("lists published entries without views and stops at the first with views", async () => {
		host = await newHost();
		await put(
			host,
			row("/quiet-1/"),
			row("/quiet-2/"),
			row("/gone/", { status: "deleted" }),
			row("/read/", { views7: 0, views30: 4 }),
		);
		await setState(host, synced);

		const thirty = await call(host, TOOL_ROUTES.unviewedEntries, { days: 30 });
		expect(thirty.items.map((i: { path: string }) => i.path).sort()).toEqual(["/quiet-1/", "/quiet-2/"]);
		expect(thirty.nextCursor).toBeUndefined();

		const seven = await call(host, TOOL_ROUTES.unviewedEntries, { days: 7 });
		expect(seven.items.map((i: { path: string }) => i.path).sort()).toEqual(["/quiet-1/", "/quiet-2/", "/read/"]);
	});

	it("finds one entry behind many rows kept for history", async () => {
		host = await newHost();
		for (let i = 0; i < 30; i++) await put(host, row(`/a-${String(i).padStart(2, "0")}/`, { status: "moved" }));
		await put(host, row("/quiet/"));
		await setState(host, synced);

		const result = await call(host, TOOL_ROUTES.unviewedEntries, { limit: 1 });

		expect(result.items.map((i: { path: string }) => i.path)).toEqual(["/quiet/"]);
	});

	it("pages while every row read has no views", async () => {
		host = await newHost();
		await put(host, row("/quiet-1/"), row("/quiet-2/"), row("/read/", { views30: 4 }));
		await setState(host, synced);

		const first = await call(host, TOOL_ROUTES.unviewedEntries, { limit: 1 });
		expect(first.items).toHaveLength(1);
		expect(first.nextCursor).toEqual(expect.any(String));

		const second = await call(host, TOOL_ROUTES.unviewedEntries, { limit: 1, cursor: first.nextCursor });
		expect(second.items).toHaveLength(1);
		expect(second.items[0].path).not.toBe(first.items[0].path);
		// The row after it has views, so there is no page to offer.
		expect(second.nextCursor).toBeUndefined();
	});
});

describe("entry_views", () => {
	async function translated() {
		const runtime = await newHost();
		await put(
			runtime,
			row("/de/a/", { entryId: "a-de", translationGroup: "a-de", locale: "de", views7: 3, views30: 30 }),
			row("/en/a/", { entryId: "a-en", translationGroup: "a-de", locale: "en", views7: 1, views30: 12 }),
			row("/fr/a/", { entryId: "a-fr", translationGroup: "a-de", locale: "fr", status: "unpublished", views30: 7 }),
		);
		await setState(runtime, synced);
		return runtime;
	}

	it("finds an entry by id, with its published translations and their total", async () => {
		host = await translated();

		const result = await call(host, TOOL_ROUTES.entryViews, { entryId: "a-en" });

		expect(result.found).toBe(true);
		expect(result.entry).toMatchObject({ entryId: "a-en", path: "/en/a/", views7: 1, views30: 12 });
		expect(result.translations.map((t: { entryId: string }) => t.entryId)).toEqual(["a-de"]);
		expect(result.allLanguages).toEqual({ views7: 4, views30: 42 });
		expect(result.windows.views7).toMatchObject({ since: addDays(TODAY, -6), until: TODAY });
	});

	it("finds an entry by the path or URL it is published at, in any spelling", async () => {
		host = await translated();

		for (const path of ["/de/a", "/de/a/", "https://example.test/de/a?ref=x"]) {
			const result = await call(host, TOOL_ROUTES.entryViews, { path });
			expect(result.entry?.entryId, path).toBe("a-de");
		}
	});

	it("leaves an unpublished entry's old numbers out of the total", async () => {
		host = await translated();

		const result = await call(host, TOOL_ROUTES.entryViews, { entryId: "a-fr" });

		expect(result.entry).toMatchObject({ entryId: "a-fr", status: "unpublished", views30: 7 });
		expect(result.allLanguages).toEqual({ views7: 4, views30: 42 });
	});

	it("reports the index incomplete while a rebuild runs", async () => {
		host = await translated();
		await setState(host, { ...synced, rebuild: true });

		const result = await call(host, TOOL_ROUTES.entryViews, { entryId: "a-de" });

		expect(result.indexComplete).toBe(false);
	});

	it("answers not found as data", async () => {
		host = await translated();

		for (const input of [{ path: "/nowhere/" }, { entryId: "missing" }, {}]) {
			const result = await call(host, TOOL_ROUTES.entryViews, input);
			expect(result, JSON.stringify(input)).toMatchObject({ found: false, entry: null, translations: [], allLanguages: null });
		}
	});
});

describe("site_totals", () => {
	it("sums the window and the period before it", async () => {
		host = await newHost();
		await seedRollup(host, 60);
		await setState(host, synced);

		const result = await call(host, TOOL_ROUTES.siteTotals, { days: 30 });

		expect(result).toMatchObject({
			window: { days: 30, since: addDays(TODAY, -29), until: TODAY, partial: false },
			pageviews: 300,
			visits: 150,
			estimated: false,
			provisional: true,
			previous: { since: addDays(TODAY, -59), until: addDays(TODAY, -30), pageviews: 300, visits: 150 },
			historySince: addDays(TODAY, -59),
		});
	});

	it("does not compare against a period the store covers only in part", async () => {
		host = await newHost();
		await seedRollup(host, 60);
		await setState(host, synced);

		const result = await call(host, TOOL_ROUTES.siteTotals, { days: 90 });

		expect(result.previous).toBeNull();
		expect(result.window.partial).toBe(true);
		expect(result.pageviews).toBe(600);
	});

	it("flags a window with a sampled day as estimated", async () => {
		host = await newHost();
		await seedRollup(host, 7);
		const date = addDays(TODAY, -3);
		await host.fixtures.plugin.storage("rollup", date, {
			date,
			pageviews: 40,
			visits: 20,
			sampleInterval: 10,
			fetchedAt: NOW.toISOString(),
		});
		await setState(host, synced);

		const result = await call(host, TOOL_ROUTES.siteTotals, { days: 7 });

		expect(result.estimated).toBe(true);
		expect(result.pageviews).toBe(6 * 10 + 40);
	});

	it("answers an empty store with zeros and no history", async () => {
		host = await newHost();

		const result = await call(host, TOOL_ROUTES.siteTotals);

		expect(result).toMatchObject({ pageviews: 0, visits: 0, previous: null, historySince: null, lastSync: null });
		expect(result.window.partial).toBe(true);
	});
});
