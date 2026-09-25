import { describe, expect, it } from "vitest";

import { nextCollectionPage, resetCursors } from "../src/sweep.js";

const PREFIX = "state:cursor:";

describe("nextCollectionPage", () => {
	it("walks a collection page by page, parking the cursor in KV", async () => {
		const store: Record<string, unknown> = {};
		const ctx = fakeCtx(store, {
			posts: [
				{ items: [entry("a")], cursor: "c1" },
				{ items: [entry("b")], cursor: null },
			],
		});

		const first = await nextCollectionPage(ctx, ["posts"], PREFIX, 1);
		expect(first).toMatchObject({ collection: "posts", lastPage: false });
		expect(store[`${PREFIX}posts`]).toBe("c1");

		const second = await nextCollectionPage(ctx, ["posts"], PREFIX, 1);
		expect(second).toMatchObject({ collection: "posts", lastPage: true });
		expect(store[`${PREFIX}posts`]).toBe("done");
	});

	it("moves on to the next collection and finally returns null", async () => {
		const store: Record<string, unknown> = { [`${PREFIX}posts`]: "done" };
		const ctx = fakeCtx(store, { pages: [{ items: [entry("x")], cursor: null }] });

		expect(await nextCollectionPage(ctx, ["posts", "pages"], PREFIX, 10)).toMatchObject({
			collection: "pages",
		});
		expect(await nextCollectionPage(ctx, ["posts", "pages"], PREFIX, 10)).toBeNull();
	});

	it("is inert without the content capability", async () => {
		const ctx = { content: undefined } as unknown as import("emdash/plugin").PluginContext;
		expect(await nextCollectionPage(ctx, ["posts"], PREFIX, 10)).toBeNull();
	});
});

describe("resetCursors", () => {
	it("clears every configured collection", async () => {
		const store: Record<string, unknown> = {
			[`${PREFIX}posts`]: "done",
			[`${PREFIX}pages`]: "c9",
		};
		await resetCursors(fakeCtx(store, {}), ["posts", "pages"], PREFIX);
		expect(store).toEqual({});
	});
});

function entry(id: string) {
	return { id, type: "posts", slug: id, status: "published", locale: null, data: {}, createdAt: "", updatedAt: "", publishedAt: null };
}

function fakeCtx(
	store: Record<string, unknown>,
	pages: Record<string, Array<{ items: ReturnType<typeof entry>[]; cursor: string | null }>>,
) {
	const served: Record<string, number> = {};
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
			list: async (collection: string) => {
				const index = served[collection] ?? 0;
				served[collection] = index + 1;
				const page = pages[collection]?.[index] ?? { items: [], cursor: null };
				return { items: page.items, cursor: page.cursor };
			},
			get: async () => null,
		},
	} as unknown as import("emdash/plugin").PluginContext;
}
