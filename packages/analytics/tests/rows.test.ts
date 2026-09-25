import { describe, expect, it } from "vitest";

import { dailyId, decideWrite, parseDailyId, sumWindow, type DailyRow } from "../src/store/rows.js";

// Yesterday: closed, so not provisional, but not yet past the freeze
// threshold. The tests that are about comparison rather than freezing need
// a day that is still writable, or freezing answers first and they pass
// for the wrong reason.
const row = (over: Partial<DailyRow> = {}): DailyRow => ({
	date: "2026-09-19",
	path: "/",
	pageviews: 10,
	visits: 8,
	sampleInterval: 1,
	fetchedAt: "2026-09-20T10:00:00.000Z",
	...over,
});

const TODAY = "2026-09-20";

describe("daily ids", () => {
	it("round-trips", () => {
		expect(parseDailyId(dailyId("2026-09-18", "/blog/"))).toEqual({ date: "2026-09-18", path: "/blog/" });
	});

	it("survives a separator inside the path", () => {
		// Nothing forbids a pipe in a URL path, and a greedy split would
		// silently truncate the path and merge two pages into one row.
		const id = dailyId("2026-09-18", "/search/a|b/");
		expect(parseDailyId(id)).toEqual({ date: "2026-09-18", path: "/search/a|b/" });
	});

	it("returns null for something that is not an id", () => {
		expect(parseDailyId("nonsense")).toBeNull();
	});
});

describe("decideWrite", () => {
	it("writes when there is nothing stored", () => {
		expect(decideWrite(undefined, row(), TODAY)).toEqual({ action: "write" });
	});

	it("writes when the numbers moved", () => {
		expect(decideWrite(row({ pageviews: 10 }), row({ pageviews: 12 }), TODAY)).toEqual({ action: "write" });
	});

	it("skips an identical row rather than spending D1 writes on it", () => {
		// Every skipped put is ~5 fewer written rows; at a 15-minute cadence
		// that is the difference between 2.2x the free budget and nothing.
		expect(decideWrite(row(), row(), TODAY)).toEqual({ action: "skip", reason: "unchanged" });
	});

	it("never overwrites a frozen row", () => {
		const frozen = row({ date: "2026-09-10", sampleInterval: 1 });
		const fresh = row({ date: "2026-09-10", pageviews: 999, sampleInterval: 1 });
		expect(decideWrite(frozen, fresh, TODAY)).toEqual({ action: "skip", reason: "frozen" });
	});

	it("never replaces an exact reading with an estimate", () => {
		// The guard that makes an accidental wide query harmless instead of
		// destructive: a sampled response reports multiples of ten and would
		// otherwise stamp over exact history.
		const exact = row({ date: "2026-09-19", pageviews: 7, sampleInterval: 1 });
		const sampled = row({ date: "2026-09-19", pageviews: 10, sampleInterval: 10 });
		expect(decideWrite(exact, sampled, TODAY)).toEqual({ action: "skip", reason: "would-downgrade" });
	});

	it("does let an exact reading replace an estimate", () => {
		const sampled = row({ date: "2026-09-19", pageviews: 10, sampleInterval: 10 });
		const exact = row({ date: "2026-09-19", pageviews: 7, sampleInterval: 1 });
		expect(decideWrite(sampled, exact, TODAY)).toEqual({ action: "write" });
	});

	it("keeps today writable all day", () => {
		const stored = row({ date: TODAY, pageviews: 3 });
		const later = row({ date: TODAY, pageviews: 9 });
		expect(decideWrite(stored, later, TODAY)).toEqual({ action: "write" });
	});

	it("reports frozen ahead of unchanged, so the reason is the useful one", () => {
		const old = row({ date: "2026-09-10" });
		expect(decideWrite(old, row({ date: "2026-09-10" }), TODAY)).toEqual({ action: "skip", reason: "frozen" });
	});
});

describe("sumWindow", () => {
	it("adds the days up and flags nothing when every row is exact and closed", () => {
		expect(
			sumWindow(
				[
					{ date: "2026-09-18", pageviews: 4, visits: 3, sampleInterval: 1 },
					{ date: "2026-09-19", pageviews: 6, visits: 5, sampleInterval: 1 },
				],
				TODAY,
			),
		).toEqual({ pageviews: 10, visits: 8, estimated: false, provisional: false });
	});

	it("flags an estimate when any day was sampled", () => {
		const out = sumWindow([{ date: "2026-09-12", pageviews: 10, visits: 10, sampleInterval: 10 }], TODAY);
		expect(out.estimated).toBe(true);
	});

	it("flags provisional when today is in the window, and still counts it", () => {
		const out = sumWindow([{ date: TODAY, pageviews: 5, visits: 5, sampleInterval: 1 }], TODAY);
		expect(out).toMatchObject({ pageviews: 5, provisional: true });
	});

	it("returns zeroes for an empty window without throwing", () => {
		expect(sumWindow([], TODAY)).toEqual({ pageviews: 0, visits: 0, estimated: false, provisional: false });
	});
});
