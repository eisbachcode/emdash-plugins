import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EntryRow } from "../src/store/rows.js";
import { olderWindow } from "../src/store/views.js";
import type { SyncState } from "../src/sync/scheduler.js";
import { addDays, enumerateDays } from "../src/sync/window.js";
import { failNextCall } from "./bridge-calls.js";
import { newHost, NOW, pathsOf, routableCollection, seedDaily, seedEntries, setState, synced, tick, TODAY } from "./host.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const YESTERDAY = addDays(TODAY, -1);
const OLDER_DAYS = enumerateDays(olderWindow(TODAY).since, olderWindow(TODAY).until);

/** A caught-up site whose older pass last ran yesterday, with the paths slot next. */
const due: SyncState = { ...synced, phase: "paths", lastWork: "paths", older: { day: YESTERDAY, complete: true } };

async function state(runtime: PluginRuntimeTestHost) {
	return await runtime.inspect.kv.get<SyncState>("state");
}

async function entry(runtime: PluginRuntimeTestHost, path: string) {
	return (await runtime.inspect.storage.get("entries", path)) as EntryRow | null;
}

/** Tick until today's older pass has finished, or give up. */
async function untilOlderDone(runtime: PluginRuntimeTestHost, limit = 30) {
	for (let i = 0; i < limit; i++) {
		const s = await state(runtime);
		if (s?.older?.day === TODAY && s.older.complete) return i;
		await tick(runtime)();
	}
	throw new Error("the older pass did not finish");
}

describe("the older pass", () => {
	it("sums each path's older days, whole, across page and tick boundaries", async () => {
		host = await newHost();
		// 25 paths of 22 rows each are six pages of up to 100, more than one
		// tick reads, so one path's rows straddle two ticks. Its first part
		// has to be carried, not written: the second tick's write is absolute.
		const paths = pathsOf(25);
		await seedEntries(host, paths);
		await seedDaily(host, paths, OLDER_DAYS);
		// Days on either side of the window must not count.
		await seedDaily(host, paths, [addDays(TODAY, -30), addDays(TODAY, -7)]);
		await setState(host, due);

		expect(await untilOlderDone(host)).toBeGreaterThan(2);

		for (const path of paths) {
			const row = await entry(host, path);
			expect(row, path).toMatchObject({ olderViews: 22 * 3, olderDay: TODAY });
			// Paths ticks ran in between and added the recent part.
			expect(row?.views30, path).toBe(22 * 3 + (row?.recentViews ?? 0));
		}
	});

	it("finishes a pass larger than one tick can read", async () => {
		host = await newHost();
		const paths = pathsOf(300, "/q-");
		await seedEntries(host, paths);
		await seedDaily(host, paths, [OLDER_DAYS[5]!]);
		await setState(host, due);

		const ticks = await untilOlderDone(host, 60);

		expect(ticks).toBeGreaterThan(2);
		const rows = await host.inspect.storage.list<EntryRow>("entries");
		expect(rows.filter((r) => r.data.olderViews !== 3).map((r) => r.id)).toEqual([]);
	});

	it("takes turns with the paths tick instead of holding the slot", async () => {
		host = await newHost();
		const paths = pathsOf(300, "/q-");
		await seedEntries(host, paths);
		await seedDaily(host, paths, [OLDER_DAYS[5]!]);
		await setState(host, due);

		const work: Array<SyncState["lastWork"]> = [];
		for (let i = 0; i < 8; i++) {
			await tick(host)();
			const s = await state(host);
			if (s?.phase === "overview") work.push(s.lastWork);
		}

		expect(work).toEqual(["older", "paths", "older", "paths"]);
	});

	it("leaves the slot to the paths tick once today's pass is done", async () => {
		host = await newHost();
		await seedEntries(host, pathsOf(2));
		await setState(host, { ...due, lastWork: "older", older: { day: TODAY, complete: true } });

		await tick(host)();

		expect((await state(host))?.lastWork).toBe("paths");
	});

	it("drops an older part the finished pass did not reach", async () => {
		// All of this entry's older traffic was on the day that left the
		// window overnight: no rows today, so the pass never writes it.
		host = await newHost();
		const [path] = pathsOf(1);
		await seedEntries(host, [path!]);
		const stale = (await entry(host, path!))!;
		await host.fixtures.plugin.storage("entries", path!, {
			...stale,
			olderViews: 40,
			olderDay: YESTERDAY,
			views30: 40,
		});
		await setState(host, due);

		await untilOlderDone(host);
		// The paths tick after it is the one that notices.
		for (let i = 0; i < 4 && (await state(host))?.lastWork !== "paths"; i++) await tick(host)();

		const after = await entry(host, path!);
		expect(after).toMatchObject({ olderViews: 0, olderDay: TODAY });
		expect(after?.views30).toBe(after?.recentViews);
	});
});

describe("the repair walk", () => {
	it("repairs rows a previous build stored, keeping their view counts", async () => {
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
		// What 6b4f7bc's walk stored: the translation as its own group, no
		// publishedAt.
		const counts = { views7: 12, views30: 30, recentViews: 14, olderViews: 16, olderDay: TODAY };
		await host.fixtures.plugin.storage("entries", "/blog/post-0-de/", {
			path: "/blog/post-0-de/",
			collection: "posts",
			entryId: translation.id,
			translationGroup: translation.id,
			locale: "de",
			// As the save hook read it through the schema's title field, which
			// the walk's listing may not match.
			title: "Beitrag 0: der Titel",
			status: "published",
			...counts,
			updatedAt: NOW.toISOString(),
		});
		const { indexVersion: _, ...legacy } = due;
		await setState(host, legacy);

		for (let i = 0; i < 4 && (await state(host))?.lastWork !== "index"; i++) await tick(host)();

		const repaired = await entry(host, "/blog/post-0-de/");
		expect(repaired).toMatchObject({ translationGroup: original, title: "Beitrag 0: der Titel", ...counts });
		expect(repaired?.publishedAt).toBeTruthy();
	});

	it("leaves the next slot to the paths tick after it fails", async () => {
		host = await newHost();
		await routableCollection(host, 2);
		await seedEntries(host, pathsOf(2));
		const { indexVersion: _, ...legacy } = due;
		await setState(host, legacy);

		failNextCall("contentList");
		await tick(host)();
		expect((await state(host))?.lastProblem?.key).toBe("indexingFailed");

		// A walk that failed must not get the slot straight back, or a
		// persistent failure would stop the view counts for good.
		await tick(host)();
		expect((await state(host))?.lastWork).toBe("paths");
		expect((await host.inspect.storage.list("daily")).length).toBeGreaterThan(0);
	});

	it("records the walk's version once it completes, so it does not run again", async () => {
		host = await newHost();
		await routableCollection(host, 2);
		const { indexVersion: _, ...legacy } = due;
		await setState(host, legacy);

		for (let i = 0; i < 12 && (await state(host))?.indexVersion === undefined; i++) await tick(host)();

		const s = await state(host);
		expect(s?.indexVersion).toBeGreaterThan(1);
		expect(s?.rebuild).toBeUndefined();
		// Kept for the analytics page, which names collections without
		// asking the schema.
		expect(s?.collectionLabels).toEqual({ posts: "Posts" });
	});
});

describe("a slug change", () => {
	it("marks the old path moved, so the entry is listed once", async () => {
		host = await newHost();
		const [id] = await routableCollection(host, 1);
		await host.transport.invokeHook("content:afterSave", { collection: "posts", content: { id, title: "Post 0" } });
		const before = (await entry(host, "/blog/post-0/"))!;
		await host.fixtures.plugin.storage("entries", "/blog/post-0/", { ...before, views30: 17 });

		await host.actions.content.update("posts", id!, { slug: "renamed" });
		await host.transport.invokeHook("content:afterSave", { collection: "posts", content: { id, title: "Post 0" } });

		await expect(entry(host, "/blog/post-0/")).resolves.toMatchObject({ status: "moved", views30: 17 });
		await expect(entry(host, "/blog/renamed/")).resolves.toMatchObject({ status: "published", entryId: id });
	});
});

describe("publishedAt", () => {
	it("is stored by the content hooks", async () => {
		host = await newHost();
		const [id] = await routableCollection(host, 1);
		const item = await host.fixtures.content("posts", {
			slug: "later",
			data: { title: "Later" },
			status: "published",
			publishedAt: "2026-09-01T08:00:00.000Z",
		});

		await host.transport.invokeHook("content:afterPublish", { collection: "posts", content: item });

		await expect(entry(host, "/blog/later/")).resolves.toMatchObject({ publishedAt: "2026-09-01T08:00:00.000Z" });
		expect(id).toBeTruthy();
	});
});
