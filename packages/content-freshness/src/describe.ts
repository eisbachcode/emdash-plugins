/**
 * The sentence shown for a hit, built from its stored params in the
 * reader's language.
 */

import { t, type Lang } from "./i18n.js";
import type { Hit } from "./rules.js";

function statusText(lang: Lang, status: string | number | undefined): string {
	if (status === "draft") return t(lang, "statusDraft");
	if (status === "scheduled") return t(lang, "statusScheduled");
	return t(lang, "statusOther", { status: String(status ?? "") });
}

export function describeHit(lang: Lang, hit: Hit): string {
	const { params } = hit;
	switch (hit.rule) {
		case "overdue-schedule":
			return params.kind === "update"
				? t(lang, "hitOverdueUpdate", { date: params.date ?? "" })
				: t(lang, "hitOverduePublish", { date: params.date ?? "", status: statusText(lang, params.status) });
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
	}
}
