import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { expect, vi } from "vitest";

import { INDEX_VERSION } from "../src/index/bootstrap.js";
import type { SyncState } from "../src/sync/scheduler.js";
import { addDays, utcDay } from "../src/sync/window.js";

/**
 * Fixtures for tests that run the plugin inside the runtime test host.
 *
 * The host itself is created and disposed by each test file, because
 * disposal belongs in that file's `afterEach`.
 */

export const NOW = new Date();
export const TODAY = utcDay(NOW);

export async function newHost(provider: "demo" | "cloudflare" = "demo") {
	if (provider === "cloudflare") {
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
	}
	const runtime = await createPluginRuntimeTestHost({
		site: { url: "https://example.test", locale: "en", trailingSlash: "always" },
	});
	if (provider === "cloudflare") {
		const saved = await runtime.actions.plugin.updateSettings({
			cfApiToken: "cfat_test",
			cfAccountId: "acct-1",
			cfSiteTag: "tag-1",
		});
		expect(saved).toMatchObject({ success: true });
	} else {
		await runtime.fixtures.plugin.setting("provider", "demo");
	}
	return runtime;
}

export async function setState(runtime: PluginRuntimeTestHost, state: SyncState) {
	await runtime.fixtures.plugin.kv("state", state);
}

export async function seedEntries(runtime: PluginRuntimeTestHost, paths: string[], views = 0) {
	for (const path of paths) {
		await runtime.fixtures.plugin.storage("entries", path, {
			path,
			collection: "posts",
			entryId: `id${path}`,
			translationGroup: `id${path}`,
			locale: "en",
			title: path,
			status: "published",
			views7: views,
			views30: views,
			updatedAt: NOW.toISOString(),
		});
	}
}

export async function seedRollup(runtime: PluginRuntimeTestHost, days: number) {
	for (let i = 0; i < days; i++) {
		const date = addDays(TODAY, -i);
		await runtime.fixtures.plugin.storage("rollup", date, {
			date,
			pageviews: 10,
			visits: 5,
			sampleInterval: 1,
			fetchedAt: NOW.toISOString(),
		});
	}
}

export async function seedDaily(runtime: PluginRuntimeTestHost, paths: string[], dates: string[]) {
	for (const date of dates) {
		for (const path of paths) {
			await runtime.fixtures.plugin.storage("daily", `${date}|${path}`, {
				date,
				path,
				pageviews: 3,
				visits: 2,
				sampleInterval: 1,
				fetchedAt: NOW.toISOString(),
			});
		}
	}
}

export async function routableCollection(runtime: PluginRuntimeTestHost, published: number, drafts = 0) {
	await runtime.fixtures.collection({
		slug: "posts",
		label: "Posts",
		urlPattern: "/blog/{slug}",
		routable: true,
		fields: [{ slug: "title", label: "Title", type: "string" }],
	});
	const ids: string[] = [];
	for (let i = 0; i < published + drafts; i++) {
		const draft = i >= published;
		const item = await runtime.fixtures.content("posts", {
			slug: `post-${i}`,
			data: { title: `Post ${i}` },
			status: draft ? "draft" : "published",
			...(draft ? {} : { publishedAt: NOW.toISOString() }),
		});
		ids.push(item.id);
	}
	return ids;
}

export function pathsOf(count: number, prefix = "/p-"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(2, "0")}/`);
}

export function daysBack(count: number): string[] {
	return Array.from({ length: count }, (_, i) => addDays(TODAY, -i));
}

export function graphql(body: unknown): Response {
	return new Response(JSON.stringify({ data: { viewer: { accounts: [body] } } }), {
		headers: { "Content-Type": "application/json" },
	});
}

export const tick = (runtime: PluginRuntimeTestHost, name = "sync") => () =>
	runtime.transport.invokeHook("cron", { name, scheduledAt: NOW.toISOString() });

/** A site that is fully caught up: index walked by this build, today's older pass done. */
export const synced: SyncState = {
	phase: "overview",
	provider: "demo",
	backfilled: true,
	indexComplete: true,
	indexVersion: INDEX_VERSION,
	older: { day: TODAY, complete: true },
	lastSync: NOW.toISOString(),
};
