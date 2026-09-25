import type { PluginContext } from "emdash/plugin";
import { describe, expect, it } from "vitest";

import plugin from "../src/plugin.js";

/**
 * The "Audit now" button schedules a one-shot task under its own name,
 * because `ctx.cron.schedule()` upserts on (plugin, task name): scheduling
 * the recurring name with a one-shot timestamp would replace the nightly
 * audit instead of running once. So the name has to differ, and the cron
 * handler has to answer to both.
 */

/** Minimal context: settings and state come from KV, and a site without collections sweeps straight to its cleanup. */
function fakeContext() {
	const warns: string[] = [];
	const reads: string[] = [];
	const ctx = {
		kv: {
			async get(key: string) {
				reads.push(key);
				return null;
			},
			async set() {},
		},
		content: {},
		schema: { listCollections: async () => [] },
		storage: { findings: { query: async () => ({ items: [], hasMore: false }) } },
		log: {
			debug() {},
			info() {},
			warn(message: string) {
				warns.push(message);
			},
			error() {},
		},
	} as unknown as PluginContext;
	return { ctx, warns, reads };
}

function cronHandler() {
	const entry = plugin.hooks?.cron;
	if (!entry) throw new Error("plugin registers no cron hook");
	return typeof entry === "function" ? entry : entry.handler;
}

async function run(name: string) {
	const { ctx, warns, reads } = fakeContext();
	await cronHandler()({ name, scheduledAt: "2026-09-20T03:00:00.000Z" }, ctx);
	return { warns, reads };
}

describe("cron task names", () => {
	it("runs for the recurring audit", async () => {
		const { reads } = await run("audit");
		expect(reads).not.toHaveLength(0);
	});

	it("runs for the one-shot the Audit now button schedules", async () => {
		// Without this the button schedules a task that fires and is
		// discarded, so the button appears to do nothing at all.
		const { reads } = await run("audit-now");
		expect(reads).not.toHaveLength(0);
	});

	it("reaches the same code path for both names", async () => {
		const recurring = await run("audit");
		const oneShot = await run("audit-now");
		expect(oneShot.warns).toEqual(recurring.warns);
		expect(oneShot.reads).toEqual(recurring.reads);
	});

	it("ignores a task belonging to something else", async () => {
		const { reads, warns } = await run("some-other-plugins-task");
		expect(reads).toHaveLength(0);
		expect(warns).toHaveLength(0);
	});
});
