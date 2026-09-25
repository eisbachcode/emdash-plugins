/**
 * The entry editor's Freshness panel.
 *
 * It checks the entry each time it opens, so a finding fixed with a plain
 * save, which no content hook reports, leaves the report as soon as someone
 * looks at the entry again. It is also where findings are set aside.
 */

import type { Block, BlockResponse } from "@emdash-cms/blocks";

import type { PanelView } from "./check.js";
import { describeHit, severityText } from "./describe.js";
import { DISMISSIBLE } from "./dismissals.js";
import { t, type Lang } from "./i18n.js";
import { RULES, type Rule } from "./rules.js";

export const PANEL_ID = "freshness";
export const SET_ASIDE_ACTION = "set_aside";
export const UNDO_ACTION = "undo";

/** The rule a panel button carries, if it names one. */
export function ruleOf(value: unknown): Rule | null {
	if (typeof value !== "object" || value === null) return null;
	const rule = (value as { rule?: unknown }).rule;
	return RULES.find((known) => known === rule) ?? null;
}

export function renderPanel(lang: Lang, view: PanelView): BlockResponse {
	if (view.skipped) return { blocks: [{ type: "context", text: t(lang, "panelSkipped") }] };
	if (view.active.length === 0 && view.setAside.length === 0) {
		return { blocks: [{ type: "context", text: t(lang, "panelClear") }] };
	}

	const blocks: Block[] = view.active.map((hit) => {
		const kind = DISMISSIBLE[hit.rule];
		return {
			type: "section",
			text: `${severityText(lang, hit.severity)}: ${describeHit(lang, hit)}`,
			...(kind
				? {
						accessory: {
							type: "button" as const,
							action_id: SET_ASIDE_ACTION,
							label: t(lang, kind === "review" ? "markReviewed" : "ignore"),
							value: { rule: hit.rule },
						},
					}
				: {}),
		};
	});

	if (view.setAside.length > 0) {
		blocks.push({ type: "context", text: t(lang, "dismissedHeader") });
		for (const { hit, dismissal } of view.setAside) {
			const until = dismissal.until
				? t(lang, "reviewedUntil", { date: dismissal.until.slice(0, 10) })
				: t(lang, "ignored");
			blocks.push({
				type: "section",
				text: `${describeHit(lang, hit)} ${until}`,
				accessory: { type: "button", action_id: UNDO_ACTION, label: t(lang, "undo"), value: { rule: hit.rule } },
			});
		}
	}
	return { blocks };
}
