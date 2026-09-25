import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { AUDIT_NOW_ACTION, SAVE_SETTINGS_ACTION, VIEW_ACTION } from "../src/report.js";
import { SETTINGS_KEY } from "../src/settings.js";
import { STATE_KEY, type State } from "../src/state.js";
import { bridgeCalls } from "./bridge-calls.js";
import { finding, newHost, undescribed } from "./host.js";

/**
 * Every invocation, at its worst case, against EmDash's sandbox limit.
 *
 * A sandboxed invocation may make ten subrequests and each `ctx` call,
 * `ctx.log` included, is one; the eleventh throws "Too many subrequests" on
 * Cloudflare. The harness does not enforce the limit, so each test counts
 * the calls and also checks the invocation did its work, so a fixture too
 * small to reach the worst case fails instead of passing quietly.
 */

const LIMIT = 10;

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function state(runtime: PluginRuntimeTestHost) {
	return runtime.inspect.kv.get<State>(STATE_KEY);
}

/**
 * Four entries, two per page, created flagged and clean in turn: whichever
 * way `content.list` orders them, every page holds one entry with a finding
 * and one without, so every audit run both writes and clears.
 */
async function twoPageSite() {
	const runtime = await newHost();
	await runtime.fixtures.plugin.kv(SETTINGS_KEY, { pageSize: 2 });
	const flagged = [];
	const clean = [];
	for (const n of [1, 2]) {
		flagged.push(await undescribed(runtime, "posts", `flagged-${n}`));
		clean.push(await runtime.fixtures.content("posts", { slug: `clean-${n}`, data: {}, status: "draft" }));
	}
	return { runtime, flagged, clean };
}

function staleRow(entryId: string) {
	return {
		collection: "posts",
		entryId,
		slug: entryId,
		locale: "en",
		rank: 2,
		hits: [{ rule: "stale-draft", severity: "low", params: { since: "2025-01-01" } }],
		entryUpdatedAt: "2025-01-01T00:00:00.000Z",
		seenIn: "2026-01-01T00:00:00.000Z",
	};
}

describe("cron runs", () => {
	it("the run that starts a sweep", async () => {
		const { runtime } = await twoPageSite();
		host = runtime;

		const calls = await bridgeCalls(() => runtime.transport.invokeHook("cron", { name: "audit" }));

		expect(calls).toEqual(expect.arrayContaining(["schemaListCollections", "storagePutMany", "storageDeleteMany"]));
		expect(calls.length).toBeLessThanOrEqual(LIMIT);
	});

	it("a follow-up that writes and clears", async () => {
		const { runtime, flagged, clean } = await twoPageSite();
		host = runtime;
		// Leftover rows for the clean entries, which the audit must clear.
		for (const entry of clean) {
			await runtime.fixtures.plugin.storage("findings", `posts:${entry.id}`, staleRow(entry.id));
		}
		await runtime.transport.invokeHook("cron", { name: "audit" });

		const calls = await bridgeCalls(() =>
			runtime.transport.invokeHook("cron", { name: "audit-next-a", data: { step: 1 } }),
		);

		expect(calls).toEqual(expect.arrayContaining(["contentList", "storagePutMany", "storageDeleteMany"]));
		expect(calls.length).toBeLessThanOrEqual(LIMIT);
		// Both pages done: every clean entry cleared, every flagged one stored.
		for (const entry of clean) expect(await finding(runtime, "posts", entry.id)).toBeNull();
		for (const entry of flagged) expect(await finding(runtime, "posts", entry.id)).not.toBeNull();
	});

	it("a cleanup run with more stale rows than one batch, and the run that finishes", async () => {
		host = await newHost();
		const runtime = host;
		for (let i = 0; i < 101; i++) {
			await runtime.fixtures.plugin.storage("findings", `posts:OLD${i}`, staleRow(`OLD${i}`));
		}
		const sweep = {
			startedAt: new Date().toISOString(),
			collections: ["posts"],
			index: 1,
			cursor: null,
			phase: "cleanup",
		};
		await runtime.fixtures.plugin.kv(STATE_KEY, { sweep, lastFinishedAt: null, scheduledAs: null });

		const batch = await bridgeCalls(() => runtime.transport.invokeHook("cron", { name: "audit-next-a", data: { step: 1 } }));
		expect(batch).toContain("storageDeleteMany");
		expect((await state(runtime))?.sweep).not.toBeNull();
		expect(batch.length).toBeLessThanOrEqual(LIMIT);

		const last = await bridgeCalls(() => runtime.transport.invokeHook("cron", { name: "audit-next-b", data: { step: 2 } }));
		expect((await state(runtime))?.sweep).toBeNull();
		expect(last.length).toBeLessThanOrEqual(LIMIT);
	});
});

describe("content hooks", () => {
	it("a state change that writes a finding", async () => {
		host = await newHost();
		const runtime = host;
		const entry = await undescribed(runtime, "posts", "published-now");

		const calls = await bridgeCalls(() =>
			runtime.transport.invokeHook("content:afterPublish", { content: { id: entry.id }, collection: "posts" }),
		);

		expect(await finding(runtime, "posts", entry.id)).not.toBeNull();
		expect(calls.length).toBeLessThanOrEqual(LIMIT);
	});
});

describe("the Freshness panel", () => {
	it("opening it, and setting a finding aside", async () => {
		host = await newHost();
		const runtime = host;
		const entry = await undescribed(runtime, "posts", "panel-budget");

		const load = await bridgeCalls(() => runtime.admin.loadEditorPanel("freshness", "posts", entry.id));
		expect(load.length).toBeLessThanOrEqual(LIMIT);

		const act = await bridgeCalls(() =>
			runtime.admin.actEditorPanel("freshness", "posts", entry.id, "set_aside", { value: { rule: "missing-description" } }),
		);
		expect(act).toContain("storagePut");
		expect(act.length).toBeLessThanOrEqual(LIMIT);
	});
});

describe("admin requests", () => {
	async function siteWithFindings() {
		const runtime = await newHost();
		// A routable collection without a URL pattern, so the banner's lookup runs too.
		await runtime.fixtures.collection({ slug: "pages", label: "Pages", routable: true });
		await undescribed(runtime, "posts", "flagged");
		await runtime.transport.invokeHook("cron", { name: "audit" });
		return runtime;
	}

	it("the first dashboard view, which also schedules the audit", async () => {
		host = await siteWithFindings();
		const runtime = host;
		const calls = await bridgeCalls(() => runtime.admin.loadWidget("summary"));
		expect(calls).toContain("cronSchedule");
		expect(calls.length).toBeLessThanOrEqual(LIMIT);
	});

	it("the first report view, which also schedules the audit", async () => {
		host = await siteWithFindings();
		const runtime = host;
		const calls = await bridgeCalls(() => runtime.admin.loadPage("/report"));
		expect(calls).toContain("cronSchedule");
		expect(calls).toContain("storageQuery");
		expect(calls.length).toBeLessThanOrEqual(LIMIT);
	});

	it("paging, Audit now and saving the settings", async () => {
		host = await siteWithFindings();
		const runtime = host;
		for (const invocation of [
			() => runtime.admin.act("/report", VIEW_ACTION, { value: { collection: "posts", rank: 1, cursor: "x" } }),
			() => runtime.admin.act("/report", AUDIT_NOW_ACTION),
			() => runtime.admin.submit("/settings", SAVE_SETTINGS_ACTION, { schedule: "15 3 * * *", staleMonths: 6 }),
		]) {
			const calls = await bridgeCalls(invocation);
			expect(calls.length).toBeLessThanOrEqual(LIMIT);
		}
	});
});
