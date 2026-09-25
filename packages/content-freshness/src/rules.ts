/**
 * The freshness rules — pure functions over one entry.
 *
 * Every rule reads fields the content API already returns (`updatedAt`,
 * `status`, `scheduledAt`, `seo`, the revision ids), plus two facts about the
 * entry's collection from `schema:read`: whether it keeps revisions, and which
 * `datetime` field, if any, the settings chose as its expiry date. The whole
 * audit runs without network access.
 *
 * A rule yields a `Hit`: the rule, its severity and the values its sentence
 * needs. Sentences are built when a page renders, never stored, so a stored
 * finding reads in whatever language the admin is shown in.
 */

import type { PluginContentItem } from "@eisbachcode/emdash-plugin-shared";

export type Severity = "high" | "medium" | "low";

export const RULES = [
	"overdue-schedule",
	"missing-description",
	"stale",
	"stale-draft",
	"description-length",
	"unpublished-changes",
	"expired",
] as const;

export type Rule = (typeof RULES)[number];

export type HitParams = Record<string, string | number>;

export interface Hit {
	rule: Rule;
	severity: Severity;
	params: HitParams;
}

/** Sort key: the lower, the more urgent. Stored so storage can order by it. */
export const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export interface Thresholds {
	/** Published entries untouched for longer than this are stale. */
	staleMonths: number;
	/** Drafts untouched for longer than this are forgotten. */
	draftMonths: number;
	descriptionMin: number;
	descriptionMax: number;
	/** Off for a site whose templates always render a description of their own. */
	reportMissingDescriptions: boolean;
	/** Changes saved to a published entry and left unpublished for longer than this are reported. */
	pendingDays: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
	staleMonths: 12,
	draftMonths: 6,
	descriptionMin: 50,
	descriptionMax: 160,
	reportMissingDescriptions: true,
	pendingDays: 14,
};

/** The `datetime` field after which a collection's entries have expired. */
export interface ExpiryField {
	slug: string;
	label: string;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** What a rule needs to know about an entry's collection. */
export interface EntryContext {
	/** The field the entry expires after, when the settings chose one. */
	expiry: ExpiryField | null;
	/** Whether the collection keeps revisions, so a draft revision means unpublished changes. */
	revisions: boolean;
}

export const NO_CONTEXT: EntryContext = { expiry: null, revisions: false };

/**
 * How long a passed schedule may wait before it counts as missed. EmDash
 * publishes scheduled entries from its own cron run, which on most sites
 * fires every few minutes, so an entry due a minute ago is not overdue yet.
 */
export const SCHEDULE_GRACE_MS = 60 * 60 * 1000;

/**
 * Field names templates commonly render as the meta description when the
 * SEO panel is empty. The page then still has a description, so a missing
 * SEO description on such an entry is a low-priority finding.
 */
const FALLBACK_FIELD = /^(?:excerpt|description|summary|intro|teaser|lead|subtitle)$|_(?:excerpt|description|summary|subheadline)$/;

function fallbackField(data: Record<string, unknown>): string | null {
	for (const [key, value] of Object.entries(data)) {
		if (FALLBACK_FIELD.test(key) && typeof value === "string" && value.trim()) return key;
	}
	return null;
}

export function evaluateEntry(
	entry: PluginContentItem,
	thresholds: Thresholds,
	now: Date,
	context: EntryContext = NO_CONTEXT,
): Hit[] {
	const hits: Hit[] = [];
	const published = entry.status === "published";

	// In a collection with revisions, a save stages the changes in a draft
	// revision and leaves `updatedAt` alone; publishing or discarding them
	// clears it. Revision ids are ULIDs, so the draft revision's id is where
	// the time of the last save is. Without revisions the pointer means
	// nothing: a restore can set it and no save clears it.
	const draftSavedAt =
		context.revisions && entry.draftRevisionId && entry.draftRevisionId !== entry.liveRevisionId
			? ulidTime(entry.draftRevisionId)
			: null;
	const lastEdit = latest(parseDate(entry.updatedAt), draftSavedAt);

	// Changes scheduled to go live are waiting on purpose; a missed schedule
	// is `overdue-schedule`'s to report.
	if (
		published &&
		draftSavedAt &&
		!entry.scheduledAt &&
		draftSavedAt.getTime() < now.getTime() - thresholds.pendingDays * DAY_MS
	) {
		hits.push({ rule: "unpublished-changes", severity: "medium", params: { since: day(draftSavedAt) } });
	}

	// EmDash stores every `datetime` value as a UTC instant, reading a value
	// without a time as midnight in the site's timezone. A plugin does not
	// know that timezone, so the instant is compared as it is and named with
	// its time in UTC.
	if (published && context.expiry) {
		const value = entry.data[context.expiry.slug];
		const ends = typeof value === "string" ? parseDate(value) : null;
		if (ends && ends.getTime() <= now.getTime()) {
			hits.push({ rule: "expired", severity: "medium", params: { field: context.expiry.label, date: minuteUtc(ends) } });
		}
	}

	// A schedule that came and went. On an unpublished entry it was meant to
	// publish it; on a published one, to publish its pending changes. Either
	// way someone expected a change to be live, and with autosave the publish
	// button does not re-enable, so a scheduled draft can sit there for good.
	const scheduledAt = parseDate(entry.scheduledAt ?? null);
	if (scheduledAt && scheduledAt.getTime() < now.getTime() - SCHEDULE_GRACE_MS) {
		hits.push({
			rule: "overdue-schedule",
			severity: "high",
			params: { date: day(scheduledAt), kind: published ? "update" : "publish" },
		});
	}

	// `seo` is undefined for a collection without SEO enabled, and that is
	// not a finding — there is nothing to fill in.
	if (published && entry.seo !== undefined) {
		const description = entry.seo.description?.trim() ?? "";
		if (!description) {
			if (thresholds.reportMissingDescriptions) {
				const fallback = fallbackField(entry.data);
				hits.push({
					rule: "missing-description",
					severity: fallback ? "low" : "medium",
					params: fallback ? { field: fallback } : {},
				});
			}
		} else if (
			description.length < thresholds.descriptionMin ||
			description.length > thresholds.descriptionMax
		) {
			hits.push({
				rule: "description-length",
				severity: "low",
				params: {
					length: description.length,
					min: thresholds.descriptionMin,
					max: thresholds.descriptionMax,
				},
			});
		}
	}

	// A threshold of 0 switches the rule off: a collection whose entries are
	// not expected to change, such as testimonials. The last edit counts
	// saves staged in a draft revision, so an entry someone is working on is
	// not stale; if they stop, `unpublished-changes` says so.
	if (lastEdit) {
		if (published && thresholds.staleMonths > 0 && lastEdit < subtractMonths(now, thresholds.staleMonths)) {
			hits.push({ rule: "stale", severity: "medium", params: { since: day(lastEdit) } });
		}
		if (entry.status === "draft" && thresholds.draftMonths > 0 && lastEdit < subtractMonths(now, thresholds.draftMonths)) {
			hits.push({ rule: "stale-draft", severity: "low", params: { since: day(lastEdit) } });
		}
	}

	return hits;
}

/** The most urgent severity among `hits`, as a rank. */
export function worstRank(hits: Hit[]): number {
	return Math.min(...hits.map((hit) => RANK[hit.severity]));
}

/**
 * `now` minus `months`, clamping the day so 31 March minus one month is
 * 28 (or 29) February rather than rolling forward into March.
 */
export function subtractMonths(from: Date, months: number): Date {
	const date = from.getUTCDate();
	const shifted = new Date(from.getTime());
	shifted.setUTCDate(1);
	shifted.setUTCMonth(shifted.getUTCMonth() - months);
	const lastDay = new Date(
		Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
	).getUTCDate();
	shifted.setUTCDate(Math.min(date, lastDay));
	return shifted;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The time a ULID was minted, from its first ten characters; null for anything that is not a ULID. */
export function ulidTime(id: string | null | undefined): Date | null {
	if (!id || !/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id)) return null;
	let ms = 0;
	for (const char of id.slice(0, 10).toUpperCase()) ms = ms * 32 + CROCKFORD.indexOf(char);
	return new Date(ms);
}

/** Field names that say when an entry stops being current. */
const EXPIRY_NAME =
	/(?:^|_)(?:end|ends|until|expires?|expiry|expiration|deadline|closes?|closing|valid_to|valid_through)(?:_at|_date|_on|_time|_datetime)?$/;

/** A collection's `datetime` fields, the only fields an expiry date can be in. */
export function datetimeFields(fields: Array<{ slug: string; label: string; type: string }>): ExpiryField[] {
	return fields
		.filter((field) => field.type === "datetime")
		.map((field) => ({ slug: field.slug, label: field.label || field.slug }));
}

/** The first of `fields` whose name says when an entry runs out: a suggestion, never applied on its own. */
export function detectExpiryField(fields: ExpiryField[]): ExpiryField | null {
	return fields.find((field) => EXPIRY_NAME.test(field.slug)) ?? null;
}

function latest(a: Date | null, b: Date | null): Date | null {
	if (!a) return b;
	if (!b) return a;
	return a > b ? a : b;
}

/** An instant to the minute, in UTC: `2026-01-30 23:00 UTC`. */
function minuteUtc(date: Date): string {
	return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Tolerant date parse — a malformed timestamp is skipped, not thrown on. */
export function parseDate(value: string | null | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function day(date: Date): string {
	return date.toISOString().slice(0, 10);
}
