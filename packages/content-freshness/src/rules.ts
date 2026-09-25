/**
 * The freshness rules — pure functions over one entry.
 *
 * Every rule reads fields the content API already returns
 * (`updatedAt`, `status`, `scheduledAt`, `seo`), so the whole audit runs
 * without network access and without knowing the collection's schema.
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
}

export const DEFAULT_THRESHOLDS: Thresholds = {
	staleMonths: 12,
	draftMonths: 6,
	descriptionMin: 50,
	descriptionMax: 160,
	reportMissingDescriptions: true,
};

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

export function evaluateEntry(entry: PluginContentItem, thresholds: Thresholds, now: Date): Hit[] {
	const hits: Hit[] = [];
	const published = entry.status === "published";
	const updatedAt = parseDate(entry.updatedAt);

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
	// not expected to change, such as testimonials.
	if (updatedAt) {
		if (published && thresholds.staleMonths > 0 && updatedAt < subtractMonths(now, thresholds.staleMonths)) {
			hits.push({ rule: "stale", severity: "medium", params: { since: day(updatedAt) } });
		}
		if (entry.status === "draft" && thresholds.draftMonths > 0 && updatedAt < subtractMonths(now, thresholds.draftMonths)) {
			hits.push({ rule: "stale-draft", severity: "low", params: { since: day(updatedAt) } });
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

/** Tolerant date parse — a malformed timestamp is skipped, not thrown on. */
export function parseDate(value: string | null | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function day(date: Date): string {
	return date.toISOString().slice(0, 10);
}
