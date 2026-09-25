import { describe, expect, it } from "vitest";

import { DEFAULT_THRESHOLDS, evaluateEntry, parseDate, subtractMonths } from "../src/rules.js";
import type { PluginContentItem } from "@eisbachcode/emdash-plugin-shared";

const NOW = new Date("2026-09-08T00:00:00.000Z");

function entry(overrides: Partial<PluginContentItem> = {}): PluginContentItem {
	return {
		id: "01ABC",
		type: "posts",
		slug: "hello",
		status: "published",
		locale: "en",
		data: {},
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		publishedAt: "2026-09-01T00:00:00.000Z",
		...overrides,
	} as PluginContentItem;
}

const rules = (item: PluginContentItem) =>
	evaluateEntry(item, "posts", DEFAULT_THRESHOLDS, NOW).map((finding) => finding.rule);

describe("evaluateEntry", () => {
	it("finds nothing wrong with a fresh, described entry", () => {
		expect(
			rules(entry({ seo: { title: null, description: "x".repeat(100), image: null, canonical: null, noIndex: false } })),
		).toEqual([]);
	});

	it("flags a published entry nobody has touched in over a year", () => {
		expect(rules(entry({ updatedAt: "2024-01-01T00:00:00.000Z" }))).toContain("stale");
	});

	it("flags a draft left for longer than the draft threshold", () => {
		const found = rules(entry({ status: "draft", updatedAt: "2025-01-01T00:00:00.000Z" }));
		expect(found).toContain("stale-draft");
		expect(found).not.toContain("stale");
	});

	it("flags a schedule that passed without publishing, at high severity", () => {
		const findings = evaluateEntry(
			entry({ status: "draft", scheduledAt: "2026-08-01T00:00:00.000Z" }),
			"posts",
			DEFAULT_THRESHOLDS,
			NOW,
		);
		const overdue = findings.find((finding) => finding.rule === "overdue-schedule");
		expect(overdue?.severity).toBe("high");
		expect(overdue?.detail).toContain("2026-08-01");
	});

	it("ignores a schedule in the future, and one that already published", () => {
		expect(rules(entry({ status: "draft", scheduledAt: "2027-01-01T00:00:00.000Z" }))).not.toContain(
			"overdue-schedule",
		);
		expect(rules(entry({ status: "published", scheduledAt: "2026-08-01T00:00:00.000Z" }))).not.toContain(
			"overdue-schedule",
		);
	});

	it("says nothing about SEO for a collection that has none", () => {
		// `seo` is undefined when the collection has SEO disabled — there
		// is nothing for an editor to fill in, so it is not a finding.
		expect(rules(entry({ seo: undefined }))).toEqual([]);
	});

	it("flags a missing description but not its length", () => {
		const found = rules(
			entry({ seo: { title: null, description: "   ", image: null, canonical: null, noIndex: false } }),
		);
		expect(found).toEqual(["missing-description"]);
	});

	describe("an entry whose page renders a description anyway", () => {
		const noSeo = { title: null, description: null, image: null, canonical: null, noIndex: false };

		it("drops to low priority and names the field templates tend to use", () => {
			// Field names from a real site whose templates fall back to them.
			for (const data of [{ excerpt: "96 Prozent …" }, { hero_subheadline: "IT-Beratung …" }]) {
				const [finding] = evaluateEntry(entry({ seo: noSeo, data }), "posts", DEFAULT_THRESHOLDS, NOW);
				expect(finding).toMatchObject({ rule: "missing-description", severity: "low" });
				expect(finding?.detail).toContain(Object.keys(data)[0]!);
			}
		});

		it("stays a real finding when the fallback is empty or not a fallback at all", () => {
			for (const data of [{ excerpt: "  " }, { hero_body: "Text" }, {}]) {
				const [finding] = evaluateEntry(entry({ seo: noSeo, data }), "posts", DEFAULT_THRESHOLDS, NOW);
				expect(finding?.severity).toBe("medium");
			}
		});

		it("is not reported at all once the site switches the check off", () => {
			const off = { ...DEFAULT_THRESHOLDS, reportMissingDescriptions: false };
			expect(evaluateEntry(entry({ seo: noSeo }), "posts", off, NOW)).toEqual([]);
			// The length check is separate and still applies.
			const short = { title: null, description: "too short", image: null, canonical: null, noIndex: false };
			expect(evaluateEntry(entry({ seo: short }), "posts", off, NOW).map((f) => f.rule)).toEqual([
				"description-length",
			]);
		});
	});

	it("flags a description that is too short or too long", () => {
		const short = rules(
			entry({ seo: { title: null, description: "too short", image: null, canonical: null, noIndex: false } }),
		);
		expect(short).toEqual(["description-length"]);

		const long = rules(
			entry({ seo: { title: null, description: "x".repeat(400), image: null, canonical: null, noIndex: false } }),
		);
		expect(long).toEqual(["description-length"]);
	});

	it("does not judge SEO on a draft", () => {
		expect(
			rules(entry({ status: "draft", seo: { title: null, description: "", image: null, canonical: null, noIndex: false } })),
		).toEqual([]);
	});

	it("skips date rules rather than throwing on a malformed timestamp", () => {
		expect(rules(entry({ updatedAt: "not a date" }))).toEqual([]);
	});
});

describe("subtractMonths", () => {
	it("clamps the day instead of rolling into the next month", () => {
		// 31 March minus one month is February, not 3 March.
		expect(subtractMonths(new Date("2026-03-31T00:00:00.000Z"), 1).toISOString().slice(0, 10)).toBe("2026-02-28");
	});

	it("crosses a year boundary", () => {
		expect(subtractMonths(new Date("2026-01-15T00:00:00.000Z"), 12).toISOString().slice(0, 10)).toBe("2025-01-15");
	});
});

describe("parseDate", () => {
	it("returns null for absent and malformed values", () => {
		expect(parseDate(null)).toBeNull();
		expect(parseDate(undefined)).toBeNull();
		expect(parseDate("nope")).toBeNull();
		expect(parseDate("2026-01-01T00:00:00.000Z")).toBeInstanceOf(Date);
	});
});
