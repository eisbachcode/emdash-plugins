/**
 * The sentence the report shows for a hit, built from its stored params.
 */

import type { Hit } from "./rules.js";

export function describeHit(hit: Hit): string {
	const { params } = hit;
	switch (hit.rule) {
		case "overdue-schedule":
			return params.kind === "update"
				? `Changes scheduled for ${params.date} were never published.`
				: `Scheduled for ${params.date} but still ${params.status}.`;
		case "missing-description":
			return params.field
				? `No SEO description; templates often show the "${params.field}" field instead.`
				: "Published without an SEO description.";
		case "description-length":
			return `SEO description is ${params.length} characters; aim for ${params.min}–${params.max}.`;
		case "stale":
			return `Not touched since ${params.since}.`;
		case "stale-draft":
			return `Draft untouched since ${params.since}.`;
	}
}
