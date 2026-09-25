import { describe, expect, it } from "vitest";

import { describeHit } from "../src/describe.js";
import {
	DEFAULT_THRESHOLDS,
	detectExpiryField,
	evaluateEntry,
	parseDate,
	subtractMonths,
	ulidTime,
} from "../src/rules.js";
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

const rules = (item: PluginContentItem) => evaluateEntry(item, DEFAULT_THRESHOLDS, NOW).map((hit) => hit.rule);

describe("evaluateEntry", () => {
	it("finds nothing wrong with a fresh, described entry", () => {
		expect(
			rules(entry({ seo: { title: null, description: "x".repeat(100), image: null, canonical: null, noIndex: false } })),
		).toEqual([]);
	});

	it("flags a published entry nobody has touched in over a year", () => {
		expect(rules(entry({ updatedAt: "2024-01-01T00:00:00.000Z" }))).toContain("stale");
	});

	it("does not call anything stale in a collection whose threshold is 0", () => {
		const never = { ...DEFAULT_THRESHOLDS, staleMonths: 0, draftMonths: 0 };
		const old = "2020-01-01T00:00:00.000Z";
		expect(evaluateEntry(entry({ updatedAt: old }), never, NOW)).toEqual([]);
		expect(evaluateEntry(entry({ status: "draft", updatedAt: old }), never, NOW)).toEqual([]);
	});

	it("flags a draft left for longer than the draft threshold", () => {
		const found = rules(entry({ status: "draft", updatedAt: "2025-01-01T00:00:00.000Z" }));
		expect(found).toContain("stale-draft");
		expect(found).not.toContain("stale");
	});

	it("flags a schedule that passed without publishing, at high severity", () => {
		const hits = evaluateEntry(
			entry({ status: "draft", scheduledAt: "2026-08-01T00:00:00.000Z" }),
			DEFAULT_THRESHOLDS,
			NOW,
		);
		const overdue = hits.find((hit) => hit.rule === "overdue-schedule");
		expect(overdue).toMatchObject({ severity: "high", params: { date: "2026-08-01", kind: "publish" } });
	});

	it("says that a scheduled entry never went live, whatever its status", () => {
		for (const status of ["draft", "scheduled"]) {
			const [hit] = evaluateEntry(entry({ status, scheduledAt: "2026-08-01T00:00:00.000Z" }), DEFAULT_THRESHOLDS, NOW);
			expect(describeHit("en", hit!)).toBe("Scheduled to go live on 2026-08-01, but it never did.");
		}
	});

	it("flags scheduled changes to a published entry that never went live", () => {
		// EmDash keeps `scheduledAt` on a published entry for scheduled draft
		// changes and clears it once they publish, so a past one was missed.
		const [hit] = evaluateEntry(
			entry({ status: "published", scheduledAt: "2026-08-01T00:00:00.000Z" }),
			DEFAULT_THRESHOLDS,
			NOW,
		);
		expect(hit).toMatchObject({ rule: "overdue-schedule", params: { kind: "update" } });
	});

	it("ignores a schedule in the future, and one the scheduler has not had time to run", () => {
		expect(rules(entry({ status: "draft", scheduledAt: "2027-01-01T00:00:00.000Z" }))).not.toContain(
			"overdue-schedule",
		);
		const minutesAgo = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
		expect(rules(entry({ status: "draft", scheduledAt: minutesAgo }))).not.toContain("overdue-schedule");
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
				const [hit] = evaluateEntry(entry({ seo: noSeo, data }), DEFAULT_THRESHOLDS, NOW);
				expect(hit).toMatchObject({
					rule: "missing-description",
					severity: "low",
					params: { field: Object.keys(data)[0] },
				});
			}
		});

		it("stays a real finding when the fallback is empty or not a fallback at all", () => {
			for (const data of [{ excerpt: "  " }, { hero_body: "Text" }, {}]) {
				const [hit] = evaluateEntry(entry({ seo: noSeo, data }), DEFAULT_THRESHOLDS, NOW);
				expect(hit?.severity).toBe("medium");
			}
		});

		it("is not reported at all once the site switches the check off", () => {
			const off = { ...DEFAULT_THRESHOLDS, reportMissingDescriptions: false };
			expect(evaluateEntry(entry({ seo: noSeo }), off, NOW)).toEqual([]);
			// The length check is separate and still applies.
			const short = { title: null, description: "too short", image: null, canonical: null, noIndex: false };
			expect(evaluateEntry(entry({ seo: short }), off, NOW).map((hit) => hit.rule)).toEqual([
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

/** A ULID minted at `at`: the time in its first ten characters, anything after. */
function ulidAt(at: string): string {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	let ms = Date.parse(at);
	let time = "";
	for (let i = 0; i < 10; i++) {
		time = alphabet[ms % 32] + time;
		ms = Math.floor(ms / 32);
	}
	return `${time}0000000000000000`;
}

describe("ulidTime", () => {
	it("reads the time a ULID was minted", () => {
		// The example from the ULID specification.
		expect(ulidTime("01ARYZ6S41TSV4RRFFQ69G5FAV")?.getTime()).toBe(1469918176385);
		expect(ulidTime(ulidAt("2026-08-01T10:00:00.000Z"))?.toISOString()).toBe("2026-08-01T10:00:00.000Z");
	});

	it("returns null for anything that is not a ULID", () => {
		expect(ulidTime("rev-1")).toBeNull();
		expect(ulidTime(null)).toBeNull();
	});
});

const REVISIONS = { expiry: null, revisions: true };

describe("unpublished changes", () => {
	const pending = (savedAt: string, extra = {}) =>
		entry({ draftRevisionId: ulidAt(savedAt), liveRevisionId: ulidAt("2026-01-01T00:00:00.000Z"), ...extra });
	const found = (item: PluginContentItem, context = REVISIONS) =>
		evaluateEntry(item, DEFAULT_THRESHOLDS, NOW, context).map((hit) => hit.rule);

	it("are reported once they have waited longer than the threshold", () => {
		const hits = evaluateEntry(pending("2026-08-01T00:00:00.000Z"), DEFAULT_THRESHOLDS, NOW, REVISIONS);
		expect(hits).toContainEqual({ rule: "unpublished-changes", severity: "medium", params: { since: "2026-08-01" } });
	});

	it("are not reported while they are recent, or when the draft is the live revision", () => {
		expect(found(pending("2026-09-01T00:00:00.000Z"))).not.toContain("unpublished-changes");
		const live = ulidAt("2026-06-01T00:00:00.000Z");
		expect(found(entry({ draftRevisionId: live, liveRevisionId: live }))).not.toContain("unpublished-changes");
		expect(found(pending("2026-06-01T00:00:00.000Z", { status: "draft" }))).not.toContain("unpublished-changes");
	});

	it("are not reported when they are scheduled to go live", () => {
		// Waiting on purpose; a missed schedule is overdue-schedule's finding.
		const scheduled = pending("2026-06-01T00:00:00.000Z", { scheduledAt: "2026-10-01T00:00:00.000Z" });
		expect(found(scheduled)).not.toContain("unpublished-changes");
	});

	it("mean nothing in a collection without revisions", () => {
		// A restore there can leave a draft pointer that no save clears.
		expect(found(pending("2026-06-01T00:00:00.000Z"), { expiry: null, revisions: false })).not.toContain(
			"unpublished-changes",
		);
	});

	it("keep an entry someone is working on from counting as stale", () => {
		const old = { updatedAt: "2024-01-01T00:00:00.000Z" };
		expect(found(pending("2026-09-01T00:00:00.000Z", old))).not.toContain("stale");
		// Changes older than the stale threshold do not.
		expect(found(pending("2025-01-01T00:00:00.000Z", old))).toContain("stale");
	});

	it("date a draft by its last save, not by the row's updatedAt", () => {
		// A save to a draft in a collection with revisions leaves updatedAt alone.
		const draft = entry({
			status: "draft",
			updatedAt: "2025-01-01T00:00:00.000Z",
			draftRevisionId: ulidAt("2026-09-01T00:00:00.000Z"),
			liveRevisionId: null,
		});
		expect(found(draft)).not.toContain("stale-draft");
		expect(found(draft, { expiry: null, revisions: false })).toContain("stale-draft");
	});
});

describe("expired entries", () => {
	const context = { expiry: { slug: "valid_until", label: "Valid until" }, revisions: false };
	const until = (value: unknown, extra = {}) =>
		evaluateEntry(entry({ data: { valid_until: value }, ...extra }), DEFAULT_THRESHOLDS, NOW, context).map(
			(hit) => hit.rule,
		);

	it("are reported once the instant in their expiry field has passed, named in UTC", () => {
		// EmDash stores a date without a time as midnight in the site's
		// timezone: 31 January in Berlin is 23:00 UTC the day before.
		const [hit] = evaluateEntry(entry({ data: { valid_until: "2026-01-30T23:00:00.000Z" } }), DEFAULT_THRESHOLDS, NOW, context);
		expect(hit).toEqual({
			rule: "expired",
			severity: "medium",
			params: { field: "Valid until", date: "2026-01-30 23:00 UTC" },
		});
	});

	it("are not reported before the instant, while unpublished, or without a chosen field", () => {
		expect(until("2026-09-08T00:00:01.000Z")).not.toContain("expired");
		expect(until("2026-09-01T00:00:00.000Z", { status: "draft" })).not.toContain("expired");
		expect(until(42)).not.toContain("expired");
		expect(rules(entry({ data: { valid_until: "2026-09-01T00:00:00.000Z" } }))).not.toContain("expired");
	});
});

describe("detectExpiryField", () => {
	const fields = (...slugs: string[]) => slugs.map((slug) => ({ slug, label: slug }));

	it("picks the first field whose name says when an entry runs out", () => {
		expect(detectExpiryField(fields("start_date", "valid_until", "end_date"))?.slug).toBe("valid_until");
	});

	it("recognises the usual names and nothing else", () => {
		for (const slug of [
			"end_date",
			"ends_on",
			"event_end",
			"end_datetime",
			"expires_at",
			"expiry",
			"expiration_date",
			"deadline",
			"closing_date",
			"offer_until",
			"valid_to",
			"valid_through",
		]) {
			expect(detectExpiryField(fields(slug))?.slug).toBe(slug);
		}
		for (const slug of ["start_date", "published_on", "weekend", "friend_date"]) {
			expect(detectExpiryField(fields(slug))).toBeNull();
		}
	});
});
