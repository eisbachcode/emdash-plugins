import { describe, expect, it } from "vitest";

import {
	addDays,
	backfillWindow,
	daysBetween,
	enumerateDays,
	isDay,
	isExact,
	isFrozen,
	isProvisional,
	syncWindow,
	UNSAMPLED_WINDOW_DAYS,
	utcDay,
} from "../src/sync/window.js";

const at = (iso: string) => new Date(iso);

describe("day arithmetic", () => {
	it("reads the UTC day, not the local one", () => {
		// 23:30 in Munich on the 20th is already the 20th in UTC; 00:30 is
		// the 19th. A local-time implementation gets the second one wrong.
		expect(utcDay(at("2026-09-20T21:30:00.000Z"))).toBe("2026-09-20");
		expect(utcDay(at("2026-09-20T23:30:00+02:00"))).toBe("2026-09-20");
		expect(utcDay(at("2026-09-21T00:30:00+02:00"))).toBe("2026-09-20");
	});

	it("crosses month, year and leap-day boundaries", () => {
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
		expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
	});

	it("survives the European DST switch", () => {
		// 2026-10-25 is the CET/CEST changeover. A local-midnight
		// implementation drifts by an hour here and lands on the wrong day.
		expect(addDays("2026-10-24", 1)).toBe("2026-10-25");
		expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
		expect(daysBetween("2026-10-24", "2026-10-27")).toBe(3);
	});

	it("counts backwards as negative", () => {
		expect(daysBetween("2026-09-20", "2026-09-13")).toBe(-7);
	});

	it("rejects things that are not days", () => {
		expect(isDay("2026-09-20")).toBe(true);
		expect(isDay("2026-9-20")).toBe(false);
		expect(isDay("2026-09-20T00:00:00Z")).toBe(false);
		expect(isDay(20260920)).toBe(false);
		expect(() => addDays("not-a-day", 1)).toThrow(RangeError);
	});

	it("enumerates inclusively and returns nothing for an inverted range", () => {
		expect(enumerateDays("2026-09-18", "2026-09-20")).toEqual(["2026-09-18", "2026-09-19", "2026-09-20"]);
		expect(enumerateDays("2026-09-20", "2026-09-20")).toEqual(["2026-09-20"]);
		expect(enumerateDays("2026-09-20", "2026-09-18")).toEqual([]);
	});
});

describe("syncWindow", () => {
	const now = at("2026-09-20T10:00:00.000Z");

	it("asks for the requested overlap when it is safe", () => {
		expect(syncWindow(now, 2)).toEqual({ since: "2026-09-18", until: "2026-09-20", clamped: false });
	});

	it("never lets date_geq cross the sampling cliff", () => {
		// The whole point. A 30-day window would return tenfold-quantized
		// numbers for every day in it, today included, so it is refused.
		const w = syncWindow(now, 30);
		expect(w.since).toBe("2026-09-13");
		expect(w.until).toBe("2026-09-20");
		expect(w.clamped).toBe(true);
		expect(daysBetween(w.since, w.until)).toBe(UNSAMPLED_WINDOW_DAYS);
	});

	it("reports honestly whether it clamped", () => {
		expect(syncWindow(now, UNSAMPLED_WINDOW_DAYS).clamped).toBe(false);
		expect(syncWindow(now, UNSAMPLED_WINDOW_DAYS + 1).clamped).toBe(true);
	});

	it("treats a zero or negative overlap as today only", () => {
		expect(syncWindow(now, 0)).toEqual({ since: "2026-09-20", until: "2026-09-20", clamped: false });
		expect(syncWindow(now, -5).since).toBe("2026-09-20");
	});

	it("backfills exactly to the cliff and no further", () => {
		const w = backfillWindow(now);
		expect(w.since).toBe("2026-09-13");
		expect(w.clamped).toBe(false);
	});
});

describe("freezing", () => {
	const today = "2026-09-20";

	it("treats today as provisional", () => {
		// Today reported sampleInterval 2.1-2.3 even in a one-day window,
		// so it is an estimate until the day closes.
		expect(isProvisional("2026-09-20", today)).toBe(true);
		expect(isProvisional("2026-09-19", today)).toBe(false);
	});

	it("never freezes today, whatever the sample interval says", () => {
		expect(isFrozen("2026-09-20", today, 1)).toBe(false);
	});

	it("keeps recent closed days writable so late beacons still land", () => {
		expect(isFrozen("2026-09-19", today, 1, 2)).toBe(false);
		expect(isFrozen("2026-09-18", today, 1, 2)).toBe(true);
	});

	it("refuses to freeze a row that was stored from a sampled response", () => {
		// Freezing an estimate would make it permanent and unfixable.
		expect(isFrozen("2026-09-15", today, 10, 2)).toBe(false);
		expect(isFrozen("2026-09-15", today, 1.35, 2)).toBe(false);
		expect(isFrozen("2026-09-15", today, 1, 2)).toBe(true);
	});

	it("calls only sampleInterval 1 exact", () => {
		expect(isExact(1)).toBe(true);
		expect(isExact(1.0000001)).toBe(false);
		expect(isExact(2.33)).toBe(false);
		expect(isExact(10)).toBe(false);
	});
});
