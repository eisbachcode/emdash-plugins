/**
 * The freshness rules — pure functions over one entry.
 *
 * Every rule reads fields the content API already returns
 * (`updatedAt`, `status`, `scheduledAt`, `seo`), so the whole audit runs
 * without network access and without knowing the collection's schema.
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

export interface Finding {
	collection: string;
	entryId: string;
	slug: string | null;
	locale: string | null;
	rule: Rule;
	severity: Severity;
	/** One sentence, shown verbatim in the report table. */
	detail: string;
	entryUpdatedAt: string;
}

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
	collection: string,
	thresholds: Thresholds,
	now: Date,
): Finding[] {
	const findings: Finding[] = [];
	const base = {
		collection,
		entryId: entry.id,
		slug: entry.slug,
		locale: entry.locale ?? null,
		entryUpdatedAt: entry.updatedAt,
	};

	const published = entry.status === "published";
	const updatedAt = parseDate(entry.updatedAt);

	// A schedule that came and went without publishing. Highest severity
	// because someone expected this to be live — and it is a failure mode
	// this stack actually produces: with autosave the publish button does
	// not re-enable, so a scheduled draft can sit there indefinitely.
	const scheduledAt = parseDate(entry.scheduledAt ?? null);
	if (scheduledAt && !published && scheduledAt < now) {
		findings.push({
			...base,
			rule: "overdue-schedule",
			severity: "high",
			detail: `Scheduled for ${scheduledAt.toISOString().slice(0, 10)} but still ${entry.status}.`,
		});
	}

	// `seo` is undefined for a collection without SEO enabled, and that is
	// not a finding — there is nothing to fill in.
	if (published && entry.seo !== undefined) {
		const description = entry.seo.description?.trim() ?? "";
		if (!description) {
			if (thresholds.reportMissingDescriptions) {
				const fallback = fallbackField(entry.data);
				findings.push({
					...base,
					rule: "missing-description",
					severity: fallback ? "low" : "medium",
					detail: fallback
						? `No SEO description; templates often show the "${fallback}" field instead.`
						: "Published without an SEO description.",
				});
			}
		} else if (
			description.length < thresholds.descriptionMin ||
			description.length > thresholds.descriptionMax
		) {
			findings.push({
				...base,
				rule: "description-length",
				severity: "low",
				detail: `SEO description is ${description.length} characters; aim for ${thresholds.descriptionMin}–${thresholds.descriptionMax}.`,
			});
		}
	}

	if (updatedAt) {
		if (published && updatedAt < subtractMonths(now, thresholds.staleMonths)) {
			findings.push({
				...base,
				rule: "stale",
				severity: "medium",
				detail: `Not touched since ${updatedAt.toISOString().slice(0, 10)}.`,
			});
		}
		if (entry.status === "draft" && updatedAt < subtractMonths(now, thresholds.draftMonths)) {
			findings.push({
				...base,
				rule: "stale-draft",
				severity: "low",
				detail: `Draft untouched since ${updatedAt.toISOString().slice(0, 10)}.`,
			});
		}
	}

	return findings;
}

/**
 * `now` minus `months`, clamping the day so 31 March minus one month is
 * 28 (or 29) February rather than rolling forward into March.
 */
export function subtractMonths(from: Date, months: number): Date {
	const day = from.getUTCDate();
	const shifted = new Date(from.getTime());
	shifted.setUTCDate(1);
	shifted.setUTCMonth(shifted.getUTCMonth() - months);
	const lastDay = new Date(
		Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
	).getUTCDate();
	shifted.setUTCDate(Math.min(day, lastDay));
	return shifted;
}

/** Tolerant date parse — a malformed timestamp is skipped, not thrown on. */
export function parseDate(value: string | null | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Stable storage id, so a re-run overwrites instead of duplicating. */
export function findingId(collection: string, entryId: string, rule: Rule): string {
	return `${collection}:${entryId}:${rule}`;
}
