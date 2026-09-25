/**
 * The sentence shown for a hit, built from its stored params in the
 * reader's language.
 */

import { t, type Lang } from "./i18n.js";
import type { Hit, Severity } from "./rules.js";

export function describeHit(lang: Lang, hit: Hit): string {
	const { params } = hit;
	switch (hit.rule) {
		case "overdue-schedule":
			return params.kind === "update"
				? t(lang, "hitOverdueUpdate", { date: params.date ?? "" })
				: t(lang, "hitOverduePublish", { date: params.date ?? "" });
		case "missing-description":
			return params.field
				? t(lang, "hitMissingFallback", { field: params.field })
				: t(lang, "hitMissingDescription");
		case "description-length":
			return t(lang, "hitDescriptionLength", params);
		case "stale":
			return t(lang, "hitStale", params);
		case "stale-draft":
			return t(lang, "hitStaleDraft", params);
		case "unpublished-changes":
			return t(lang, "hitUnpublishedChanges", params);
		case "expired":
			return t(lang, "hitExpired", params);
	}
}

const SEVERITY_KEY = { high: "priorityHigh", medium: "priorityMedium", low: "priorityLow" } as const;

export function severityText(lang: Lang, severity: Severity): string {
	return t(lang, SEVERITY_KEY[severity]);
}
