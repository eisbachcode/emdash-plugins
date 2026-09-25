import { describe, expect, it } from "vitest";

import { dismissalFor, partition, type EntryDismissals } from "../src/dismissals.js";
import { DEFAULT_THRESHOLDS, type Hit } from "../src/rules.js";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const stale: Hit = { rule: "stale", severity: "medium", params: { since: "2025-01-01" } };
const missing: Hit = { rule: "missing-description", severity: "medium", params: {} };
const overdue: Hit = { rule: "overdue-schedule", severity: "high", params: { date: "2026-09-01", kind: "publish", status: "draft" } };

function dismissed(rules: EntryDismissals["rules"]): EntryDismissals {
	return { collection: "pages", entryId: "01A", rules };
}

describe("setting a finding aside", () => {
	it("holds a reviewed stale entry back for as long as the stale threshold", () => {
		const dismissal = dismissalFor("stale", { ...DEFAULT_THRESHOLDS, staleMonths: 24 }, NOW, "u1");
		expect(dismissal?.until?.slice(0, 10)).toBe("2028-09-25");
	});

	it("ignores a description finding for good, and never a missed schedule", () => {
		expect(dismissalFor("missing-description", DEFAULT_THRESHOLDS, NOW, null)?.until).toBeNull();
		expect(dismissalFor("overdue-schedule", DEFAULT_THRESHOLDS, NOW, null)).toBeNull();
	});

	it("lets a review run out", () => {
		const aside = dismissed({ stale: { until: "2026-09-01T00:00:00.000Z", by: null, at: "2025-09-01T00:00:00.000Z" } });
		expect(partition([stale], aside, NOW).active).toEqual([stale]);
	});

	it("keeps what is set aside out of the active findings", () => {
		const aside = dismissed({
			stale: { until: "2027-01-01T00:00:00.000Z", by: null, at: NOW.toISOString() },
			"missing-description": { until: null, by: null, at: NOW.toISOString() },
		});
		expect(partition([stale, missing, overdue], aside, NOW)).toEqual({ active: [overdue], setAside: [stale, missing] });
	});
});
