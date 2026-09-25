import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, type Settings } from "../src/settings.js";
import { auditNextPage } from "../src/sweep.js";

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, pageSize: 10 };
const COLLECTIONS = ["posts"];

describe("auditNextPage", () => {
	it("writes findings and clears the rules that no longer fire, in one call each", async () => {
		const writes: Array<{ id: string }> = [];
		const clears: string[] = [];
		let putCalls = 0;
		let deleteCalls = 0;

		const ctx = fakeCtx(
			[{ items: [staleEntry()], cursor: null }],
			{
				putMany: async (items) => {
					putCalls += 1;
					writes.push(...items);
				},
				deleteMany: async (ids) => {
					deleteCalls += 1;
					clears.push(...ids);
					return ids.length;
				},
			},
		);

		const result = await auditNextPage(ctx, SETTINGS, COLLECTIONS);
		expect(result).toMatchObject({ collection: "posts", entries: 1, found: 1 });
		expect(writes.map((item) => item.id)).toEqual(["posts:01STALE:stale"]);
		// The other four rules are cleared so a fixed finding disappears.
		expect(clears).toHaveLength(4);
		// Batched: one write call and one delete call for the whole page.
		expect([putCalls, deleteCalls]).toEqual([1, 1]);
	});

	it("returns null when every collection is walked", async () => {
		const ctx = fakeCtx([], {});
		// The fake serves an empty last page, so the cursor lands on "done".
		await auditNextPage(ctx, SETTINGS, COLLECTIONS);
		expect(await auditNextPage(ctx, SETTINGS, COLLECTIONS)).toBeNull();
	});
});

function staleEntry() {
	return {
		id: "01STALE",
		type: "posts",
		slug: "old-news",
		status: "published",
		locale: "en",
		data: {},
		createdAt: "2020-01-01T00:00:00.000Z",
		updatedAt: "2020-01-01T00:00:00.000Z",
		publishedAt: "2020-01-01T00:00:00.000Z",
	};
}

function fakeCtx(
	pages: Array<{ items: ReturnType<typeof staleEntry>[]; cursor: string | null }>,
	storage: {
		putMany?: (items: Array<{ id: string; data: unknown }>) => Promise<void>;
		deleteMany?: (ids: string[]) => Promise<number>;
	},
) {
	const store: Record<string, unknown> = {};
	let served = 0;
	return {
		kv: {
			get: async (key: string) => store[key] ?? null,
			set: async (key: string, value: unknown) => {
				store[key] = value;
			},
			delete: async (key: string) => delete store[key],
			list: async () => [],
		},
		content: {
			list: async () => pages[served++] ?? { items: [], cursor: null },
			get: async () => null,
		},
		storage: {
			findings: {
				putMany: storage.putMany ?? (async () => {}),
				deleteMany: storage.deleteMany ?? (async () => 0),
				count: async () => 0,
				query: async () => ({ items: [], cursor: null }),
			},
		},
	} as unknown as import("emdash/plugin").PluginContext;
}
