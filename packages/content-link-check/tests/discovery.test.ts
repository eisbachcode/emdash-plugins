import type { PluginContext } from "emdash/plugin";
import { describe, expect, it } from "vitest";

import plugin from "../src/plugin.js";

/**
 * A fresh install has no settings at all. The sweep has to find the site's
 * collections itself, or the plugin sits idle until someone discovers a
 * settings field and types the collection names in.
 */

function fakeContext(collections: Record<string, string[]>) {
	const kv = new Map<string, unknown>();
	const listed: Array<{ collection: string; status: unknown }> = [];
	const noRows = { items: [], cursor: undefined };
	const ctx = {
		kv: {
			get: async (key: string) => kv.get(key) ?? null,
			set: async (key: string, value: unknown) => void kv.set(key, value),
			list: async () => [...kv].map(([key, value]) => ({ key, value })),
		},
		schema: {
			listCollections: async () => Object.keys(collections).map((slug) => ({ slug })),
		},
		content: {
			list: async (collection: string, options?: { where?: { status?: unknown } }) => {
				listed.push({ collection, status: options?.where?.status });
				return {
					items: (collections[collection] ?? []).map((id) => ({ id, status: "published", data: {} })),
					cursor: undefined,
				};
			},
		},
		storage: {
			checks: { query: async () => noRows, getMany: async () => new Map(), putMany: async () => {} },
		},
		cron: { list: async () => [], schedule: async () => {} },
		site: { url: "https://example.test" },
		log: { debug() {}, info() {}, warn() {}, error() {} },
	} as unknown as PluginContext;
	return { ctx, listed };
}

async function tick(ctx: PluginContext, name: string) {
	const entry = plugin.hooks?.cron;
	if (!entry) throw new Error("plugin registers no cron hook");
	const handler = typeof entry === "function" ? entry : entry.handler;
	await handler({ name, scheduledAt: "2026-09-24T03:00:00.000Z" }, ctx);
}

describe("collection discovery", () => {
	it("walks the published entries of every collection without any configuration", async () => {
		const { ctx, listed } = fakeContext({ posts: ["p1", "p2"], pages: ["about"] });

		await tick(ctx, "sweep");
		await tick(ctx, "sweep-next-a");

		expect(listed).toEqual([
			{ collection: "posts", status: "published" },
			{ collection: "pages", status: "published" },
		]);
	});
});
