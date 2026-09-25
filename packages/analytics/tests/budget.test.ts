import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GRAPHQL_ENDPOINT, RUM_DATASET } from "../src/providers/cloudflare.js";
import { WAITING_KEY, type SyncState } from "../src/sync/scheduler.js";
import { addDays } from "../src/sync/window.js";
import { PAGE_REFRESH_ACTION, RANGE_ACTION, SETUP_ACTION } from "../src/ui/page.js";
import { bridgeCalls, failNextCall } from "./bridge-calls.js";
import {
	daysBack,
	graphql,
	newHost,
	NOW,
	pathsOf,
	routableCollection,
	seedDaily,
	seedEntries,
	seedRollup,
	setState,
	synced,
	tick,
	TODAY,
} from "./host.js";

/**
 * Every invocation, at its worst case, against EmDash's sandbox limit.
 *
 * A sandboxed invocation may make ten subrequests and each `ctx` call is
 * one; the eleventh throws "Too many subrequests" on Cloudflare and aborts
 * the tick or the render. The harness does not enforce the limit, so each
 * test here counts the calls and also checks the invocation did its full
 * share of work, so a fixture too small to reach the worst case fails
 * instead of passing quietly.
 */

const LIMIT = 10;

/** The most paths a paths tick asks about; the fixture below covers exactly that many. */
const PATHS_PER_TICK = 36;

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

describe("sync ticks", () => {
	it("an overview tick", async () => {
		host = await newHost("cloudflare");
		const series = daysBack(8).map((date) => ({
			count: 10,
			sum: { visits: 5 },
			avg: { sampleInterval: 1 },
			dimensions: { date },
		}));
		await host.http.respond(
			GRAPHQL_ENDPOINT,
			graphql({ totals: [{ count: 80, sum: { visits: 40 } }], series, pages: [], refs: [], geo: [] }),
		);

		const calls = await bridgeCalls(tick(host));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		await expect(host.inspect.storage.get("rollup", addDays(TODAY, -7))).resolves.not.toBeNull();
	});

	it("an index tick", async () => {
		host = await newHost();
		await routableCollection(host, 5);
		await setState(host, { ...synced, phase: "paths", indexComplete: false });

		const calls = await bridgeCalls(tick(host));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		const state = await host.inspect.kv.get<SyncState>("state");
		expect(state?.lastError).toBeUndefined();
		expect(state?.indexed).toBeGreaterThanOrEqual(3);
	});

	it("a paths tick", async () => {
		host = await newHost("cloudflare");
		// More entries than one tick may ask about, each with traffic on every
		// day of the window, none of it stored yet.
		const paths = pathsOf(40);
		await seedEntries(host, paths);
		await setState(host, { ...synced, phase: "paths", provider: "cloudflare" });

		const window = daysBack(8);
		const asked = paths.slice(0, PATHS_PER_TICK);
		const rows = asked.flatMap((path) =>
			window.map((date) => ({
				count: 7,
				sum: { visits: 3 },
				avg: { sampleInterval: 1 },
				dimensions: { date, requestPath: path },
			})),
		);
		await host.http.respond(GRAPHQL_ENDPOINT, graphql({ [RUM_DATASET]: rows }));

		const calls = await bridgeCalls(tick(host));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		const sent = JSON.parse(new TextDecoder().decode(host.http.requests()[0]!.body)) as {
			variables: { paths: string[] };
		};
		expect(sent.variables.paths.filter((path) => path.endsWith("/"))).toEqual(asked);
		await expect(host.inspect.storage.get("daily", `${window[7]}|${asked[35]}`)).resolves.not.toBeNull();
		// Eight days of seven views: the last seven make views7, all eight the
		// recent part of views30.
		await expect(host.inspect.storage.get("entries", asked[35]!)).resolves.toMatchObject({ views7: 49, views30: 56 });
	});

	it("every step of an older pass over more paths than one step can finish", async () => {
		// One row per path is the expensive shape: every row read finishes a
		// path, so every page can add a hundred entries to look up and write.
		host = await newHost();
		const paths = pathsOf(300, "/q-");
		await seedEntries(host, paths);
		await seedDaily(host, paths, [addDays(TODAY, -20)]);
		await setState(host, { ...synced, phase: "paths", lastWork: "paths", older: { day: addDays(TODAY, -1), complete: true } });

		let steps = 0;
		for (let i = 0; i < 60; i++) {
			const before = await host.inspect.kv.get<SyncState>("state");
			if (before?.older?.day === TODAY && before.older.complete) break;
			const calls = await bridgeCalls(tick(host));
			expect(calls.length, `tick ${i}: ${calls.join(", ")}`).toBeLessThanOrEqual(LIMIT);
			if ((await host.inspect.kv.get<SyncState>("state"))?.lastWork === "older" && before?.lastWork !== "older") steps++;
		}

		expect(steps).toBeGreaterThan(1);
		await expect(host.inspect.storage.get("entries", paths[299]!)).resolves.toMatchObject({ olderViews: 3 });
	});

	it("a Refresh tick", async () => {
		host = await newHost();
		await setState(host, { ...synced, phase: "paths" });
		const calls = await bridgeCalls(tick(host, "refresh"));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		await expect(host.inspect.storage.get("rollup", TODAY)).resolves.not.toBeNull();
	});

	it("every tick of a provider-switch wipe, until it completes", async () => {
		host = await newHost();
		await host.fixtures.plugin.setting("provider", "cloudflare");
		const paths = pathsOf(40);
		await seedEntries(host, paths, 12);
		await seedRollup(host, 150);
		await seedDaily(host, paths, daysBack(10));
		await setState(host, synced);

		let ticks = 0;
		let state: SyncState | null = null;
		for (; ticks < 20 && state?.provider !== "cloudflare"; ticks++) {
			const calls = await bridgeCalls(tick(host));
			expect(calls.length, `tick ${ticks}: ${calls.join(", ")}`).toBeLessThanOrEqual(LIMIT);
			state = await host.inspect.kv.get<SyncState>("state");
		}

		expect(state?.provider).toBe("cloudflare");
		expect(ticks).toBeGreaterThan(1);
		await expect(host.inspect.storage.list("rollup")).resolves.toEqual([]);
		await expect(host.inspect.storage.list("daily")).resolves.toEqual([]);
		await expect(host.inspect.storage.get("entries", paths[39]!)).resolves.toMatchObject({ views7: 0, views30: 0 });
	});

	it("a reconcile run with more to prune than one run can delete", async () => {
		host = await newHost();
		const old = Array.from({ length: 10 }, (_, i) => addDays(TODAY, -200 - i));
		await seedDaily(host, pathsOf(50), old);

		const calls = await bridgeCalls(tick(host, "reconcile"));

		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		const left = (await host.inspect.storage.list("daily")).length;
		expect(left).toBeGreaterThan(0);
		expect(left).toBeLessThan(500);
	});
});

describe("admin requests", () => {
	/** Five top paths, a full comparison window, and 90 days of per-entry rows. */
	async function withData(runtime: PluginRuntimeTestHost) {
		const paths = pathsOf(5);
		await seedEntries(runtime, paths);
		await seedRollup(runtime, 180);
		await seedDaily(runtime, paths, daysBack(60));
		await setState(runtime, {
			...synced,
			topPaths: paths.map((path) => ({ path, pageviews: 10, visits: 5 })),
		});
	}

	it("a widget load", async () => {
		host = await newHost();
		await withData(host);
		const calls = await bridgeCalls(() => host!.admin.loadWidget("traffic"));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("cronSchedule");
	});

	it("a widget load before the first sync, which marks the wait", async () => {
		host = await newHost();
		await withData(host);
		await setState(host, { phase: "overview", topPaths: pathsOf(5).map((path) => ({ path, pageviews: 10, visits: 5 })) });
		const calls = await bridgeCalls(() => host!.admin.loadWidget("traffic"));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(await host.inspect.kv.get(WAITING_KEY)).toEqual(expect.any(String));
	});

	it("a setup check on a Cloudflare site that has not synced yet", async () => {
		host = await newHost("cloudflare");
		await host.http.respond(
			GRAPHQL_ENDPOINT,
			graphql({ [RUM_DATASET]: [{ count: 5, dimensions: { siteTag: "tag-1", requestHost: "example.test" } }] }),
		);
		const calls = await bridgeCalls(() => host!.admin.act("/analytics", SETUP_ACTION, { value: 30 }));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(host.http.requests()).toHaveLength(1);
	});

	it("a widget Refresh", async () => {
		host = await newHost();
		await withData(host);
		const calls = await bridgeCalls(() => host!.admin.act("widget:traffic", "analytics:refresh"));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect((await host.inspect.scheduledTasks()).map((t) => String(t.name))).toContain("refresh");
	});

	it("an analytics page load over 90 days, answered live", async () => {
		host = await newHost();
		await withData(host);
		const calls = await bridgeCalls(() => host!.admin.act("/analytics", RANGE_ACTION, { value: 90 }));
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(calls).toContain("storageGetMany");
	});

	it("an analytics page Refresh over 90 days, falling back to the store", async () => {
		// The provider fails, so the page reads rollups and daily rows as
		// well: its most expensive path.
		host = await newHost("cloudflare");
		await withData(host);
		await host.http.respond(GRAPHQL_ENDPOINT, new Response("upstream down", { status: 502 }));
		let toast: unknown;
		const calls = await bridgeCalls(async () => {
			toast = (await host!.admin.act("/analytics", PAGE_REFRESH_ACTION, { value: 90 })).toast;
		});
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		expect(toast).toMatchObject({ type: "error" });
		expect(calls.filter((c) => c === "storageQuery").length).toBeGreaterThanOrEqual(5);
	});
});

describe("content hooks", () => {
	it("a save, which also schedules", async () => {
		host = await newHost();
		const [id] = await routableCollection(host, 1);
		const calls = await bridgeCalls(() =>
			host!.transport.invokeHook("content:afterSave", {
				collection: "posts",
				content: { id, title: "Post 0" },
				isNew: false,
			}),
		);
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		await expect(host.inspect.storage.get("entries", "/blog/post-0/")).resolves.toMatchObject({ entryId: id });
	});

	it("an unpublish", async () => {
		host = await newHost();
		await seedEntries(host, ["/blog/post-0/"]);
		const calls = await bridgeCalls(() =>
			host!.transport.invokeHook("content:afterUnpublish", { collection: "posts", content: { id: "id/blog/post-0/" } }),
		);
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(LIMIT);
		await expect(host.inspect.storage.get("entries", "/blog/post-0/")).resolves.toMatchObject({
			status: "unpublished",
		});
	});
});

describe("the index walk", () => {
	it("indexes every published entry across ticks and skips drafts", async () => {
		host = await newHost();
		const ids = await routableCollection(host, 7, 2);
		await setState(host, { ...synced, phase: "paths", indexComplete: false });

		for (let i = 0; i < 20 && !(await host.inspect.kv.get<SyncState>("state"))?.indexComplete; i++) {
			await tick(host)();
		}

		const rows = await host.inspect.storage.list<{ entryId: string }>("entries");
		expect(rows.map((r) => r.data.entryId).sort()).toEqual(ids.slice(0, 7).sort());
	});

	it("files a translation under its original's group", async () => {
		host = await newHost();
		const [original] = await routableCollection(host, 1);
		const translation = await host.fixtures.content("posts", {
			slug: "post-0-de",
			locale: "de",
			translationOf: original,
			data: { title: "Beitrag 0" },
			status: "published",
			publishedAt: NOW.toISOString(),
		});
		await setState(host, { ...synced, phase: "paths", indexComplete: false });

		for (let i = 0; i < 20 && !(await host.inspect.kv.get<SyncState>("state"))?.indexComplete; i++) {
			await tick(host)();
		}

		const rows = await host.inspect.storage.list<{ entryId: string; translationGroup: string }>("entries");
		const groups = Object.fromEntries(rows.map((r) => [r.data.entryId, r.data.translationGroup]));
		expect(groups).toEqual({ [original!]: original, [translation.id]: original });
	});

	it("repeats a page whose tick failed instead of skipping it", async () => {
		// The cursor is saved with the state after the page's rows. Saved
		// before them, a tick that dies in between loses its page for good.
		host = await newHost();
		const ids = await routableCollection(host, 5);
		await setState(host, { ...synced, phase: "paths", indexComplete: false });

		failNextCall("storagePutMany");
		await tick(host)();
		expect((await host.inspect.kv.get<SyncState>("state"))?.lastProblem?.key).toBe("indexingFailed");
		await expect(host.inspect.storage.list("entries")).resolves.toEqual([]);

		for (let i = 0; i < 20 && !(await host.inspect.kv.get<SyncState>("state"))?.indexComplete; i++) {
			await tick(host)();
		}

		const rows = await host.inspect.storage.list<{ entryId: string }>("entries");
		expect(rows.map((r) => r.data.entryId).sort()).toEqual([...ids].sort());
	});
});
