import { describe, expect, it } from "vitest";

import type { EntryRow } from "../src/store/rows.js";
import { foldByPath, olderWindow, recentViewsOf, withOlder, withRecent } from "../src/store/views.js";
import { addDays, daysBetween, enumerateDays } from "../src/sync/window.js";

const TODAY = "2026-09-24";

const entry = (over: Partial<EntryRow> = {}): EntryRow => ({
	path: "/blog/hello/",
	collection: "posts",
	entryId: "e1",
	translationGroup: "e1",
	locale: "en",
	title: "Hello",
	status: "published",
	views7: 0,
	views30: 0,
	updatedAt: "2026-09-24T00:00:00.000Z",
	...over,
});

describe("the two windows", () => {
	it("cover thirty days between them, with no day in both", () => {
		// The recent part is what a paths tick fetches: today - 7 to today.
		const recent = enumerateDays(addDays(TODAY, -7), TODAY);
		const { since, until } = olderWindow(TODAY);
		const older = enumerateDays(since, until);

		expect(recent.length + older.length).toBe(30);
		expect(older.filter((day) => recent.includes(day))).toEqual([]);
		expect(daysBetween(until, recent[0]!)).toBe(1);
	});
});

describe("recentViewsOf", () => {
	it("counts seven days for views7 and eight for the recent part", () => {
		const rows = enumerateDays(addDays(TODAY, -7), TODAY).map((date) => ({ date, pageviews: 1 }));
		expect(recentViewsOf(rows, TODAY)).toEqual({ views7: 7, recent: 8 });
	});

	it("ignores rows outside the window instead of adding them", () => {
		const rows = [
			{ date: addDays(TODAY, -8), pageviews: 100 },
			{ date: addDays(TODAY, 1), pageviews: 100 },
			{ date: TODAY, pageviews: 2 },
		];
		expect(recentViewsOf(rows, TODAY)).toEqual({ views7: 2, recent: 2 });
	});
});

describe("withRecent", () => {
	it("adds today's older part to the fetched recent part", () => {
		const next = withRecent(entry({ olderViews: 40, olderDay: TODAY }), { views7: 5, recent: 6 }, TODAY, true);
		expect(next).toMatchObject({ views7: 5, recentViews: 6, olderViews: 40, views30: 46 });
	});

	it("keeps yesterday's older part while today's pass is still running", () => {
		const next = withRecent(
			entry({ olderViews: 40, olderDay: addDays(TODAY, -1) }),
			{ views7: 5, recent: 6 },
			TODAY,
			false,
		);
		expect(next).toMatchObject({ olderViews: 40, views30: 46 });
	});

	it("zeroes an older part today's finished pass did not reach", () => {
		// All of this entry's older traffic was on the day that just left the
		// window, so the pass found no rows for it and never wrote it.
		const next = withRecent(
			entry({ olderViews: 40, olderDay: addDays(TODAY, -1) }),
			{ views7: 5, recent: 6 },
			TODAY,
			true,
		);
		expect(next).toMatchObject({ olderViews: 0, olderDay: TODAY, views30: 6 });
	});

	it("reports no change when nothing moved, so the tick writes nothing", () => {
		const settled = entry({ views7: 5, recentViews: 6, olderViews: 40, olderDay: TODAY, views30: 46 });
		expect(withRecent(settled, { views7: 5, recent: 6 }, TODAY, true)).toBeNull();
	});

	it("repairs a views30 that an older build left at zero", () => {
		const legacy = entry({ views7: 5, views30: 0 });
		expect(withRecent(legacy, { views7: 5, recent: 6 }, TODAY, false)).toMatchObject({ views30: 6 });
	});
});

describe("withOlder", () => {
	it("writes the day even when the number is unchanged", () => {
		const next = withOlder(entry({ olderViews: 40, olderDay: addDays(TODAY, -1), recentViews: 6 }), 40, TODAY);
		expect(next).toMatchObject({ olderDay: TODAY, views30: 46 });
	});

	it("reports no change when the day and the number match", () => {
		expect(withOlder(entry({ olderViews: 40, olderDay: TODAY }), 40, TODAY)).toBeNull();
	});
});

describe("foldByPath", () => {
	const rows = (path: string, n: number) => Array.from({ length: n }, () => ({ path, pageviews: 2 }));

	it("finishes every path of the last page", () => {
		const { finished, carry } = foldByPath([...rows("/a/", 3), ...rows("/b/", 2)], undefined, false);
		expect(Object.fromEntries(finished)).toEqual({ "/a/": 6, "/b/": 4 });
		expect(carry).toBeUndefined();
	});

	it("carries a path that may continue on the next page", () => {
		const first = foldByPath([...rows("/a/", 3), ...rows("/b/", 2)], undefined, true);
		expect(Object.fromEntries(first.finished)).toEqual({ "/a/": 6 });
		expect(first.carry).toEqual({ path: "/b/", views: 4 });

		const second = foldByPath([...rows("/b/", 1), ...rows("/c/", 1)], first.carry, false);
		expect(Object.fromEntries(second.finished)).toEqual({ "/b/": 6, "/c/": 2 });
	});

	it("finishes a carry whose path does not continue", () => {
		const { finished } = foldByPath(rows("/c/", 1), { path: "/b/", views: 4 }, false);
		expect(Object.fromEntries(finished)).toEqual({ "/b/": 4, "/c/": 2 });
	});

	it("finishes a carry when the next page is empty", () => {
		const { finished, carry } = foldByPath([], { path: "/b/", views: 4 }, false);
		expect(Object.fromEntries(finished)).toEqual({ "/b/": 4 });
		expect(carry).toBeUndefined();
	});
});
