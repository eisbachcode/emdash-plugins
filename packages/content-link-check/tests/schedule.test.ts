import { ROLE } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The plugin remembers, per isolate, that it has seen its sweep in place.
 * Each test loads a fresh copy so that memory starts empty.
 */
let plugin: SandboxedPlugin;

beforeEach(async () => {
	vi.resetModules();
	plugin = (await import("../src/plugin.js")).default;
});

interface FakeCron {
	list(): Promise<Array<{ name: string; schedule: string }>>;
	schedule(name: string, opts: { schedule: string }): Promise<void>;
}

function fakeContext(cron: FakeCron, kv: Record<string, unknown> = {}) {
	return {
		cron,
		kv: {
			get: async (key: string) => kv[key] ?? null,
			list: async () => Object.entries(kv).map(([key, value]) => ({ key, value })),
		},
		storage: {
			checks: { count: async () => 0, query: async () => ({ items: [], cursor: null }) },
		},
		log: { debug() {}, info() {}, warn() {}, error() {} },
	} as unknown as PluginContext;
}

async function loadWidget(ctx: PluginContext) {
	const route = plugin.routes?.admin;
	if (!route || typeof route === "function") throw new Error("plugin registers no admin route object");
	return (await route.handler(
		{
			input: { type: "page_load", page: "widget:summary" },
			request: { url: "https://example.test", method: "POST", headers: {} },
			user: { id: "u1", email: "admin@example.test", name: null, role: ROLE.ADMIN },
		} as never,
		ctx,
	)) as { blocks?: unknown[] };
}

describe("the sweep schedule", () => {
	it("is put back on the saved schedule when the registered task has drifted from it", async () => {
		const scheduled: Array<[string, string]> = [];
		const cron: FakeCron = {
			list: async () => [{ name: "sweep", schedule: "0 3 * * *" }],
			schedule: async (name, opts) => void scheduled.push([name, opts.schedule]),
		};
		await loadWidget(fakeContext(cron, { settings: { schedule: "0 5 * * *" } }));
		expect(scheduled).toEqual([["sweep", "0 5 * * *"]]);
	});

	it("is left alone when the registered task matches the saved schedule", async () => {
		const scheduled: string[] = [];
		const cron: FakeCron = {
			list: async () => [{ name: "sweep", schedule: "0 3 * * *" }],
			schedule: async (name) => void scheduled.push(name),
		};
		await loadWidget(fakeContext(cron));
		expect(scheduled).toEqual([]);
	});

	it("never costs the admin the page when it cannot be checked", async () => {
		const unavailable = async () => {
			throw new Error("cron unavailable");
		};
		const result = await loadWidget(fakeContext({ list: unavailable, schedule: unavailable }));
		expect(result.blocks?.length).toBeGreaterThan(0);
	});
});
