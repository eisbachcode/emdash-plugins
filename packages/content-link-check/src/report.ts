/**
 * Block Kit surfaces: the report page, the settings form, and the
 * dashboard widget.
 *
 * Block Kit is the whole admin UI for a sandboxed plugin — `table`
 * carries sorting and pagination, `stats` gives the metric cards, and
 * `empty` covers the clean state. No React, and no editor slot needed.
 */

import type { PluginContext } from "emdash/plugin";

import type { Settings } from "./settings.js";
import type { SweepState } from "./state.js";
import { FINDINGS, type CheckRow } from "./store.js";

type Block = Record<string, unknown>;

/** Block Kit requires a table to name the action its paging and sorting send. */
export const REPORT_PAGE_ACTION = "report_page";

const REPORT_LIMIT = 100;

export interface Counts {
	broken: number;
	redirect: number;
	unknown: number;
	/** Targets checked at least once. */
	total: number;
}

/** Counts of distinct targets, so the widget and the report agree. */
export async function countLinks(ctx: PluginContext): Promise<Counts> {
	const [broken, redirect, unknown, total] = await Promise.all([
		ctx.storage.checks.count({ finding: { in: ["broken", "malformed"] } }),
		ctx.storage.checks.count({ finding: "redirect" }),
		ctx.storage.checks.count({ state: "unknown" }),
		ctx.storage.checks.count({ state: { in: ["ok", "redirect", "broken", "unknown", "malformed"] } }),
	]);
	return { broken, redirect, unknown, total };
}

function progress(state: SweepState, requestedAt: string | null): string {
	if (requestedAt && requestedAt > (state.startedAt ?? "")) {
		return "A full sweep has been requested; it starts with the next run of the site's cron trigger.";
	}
	if (state.phase === "done") {
		return state.finishedAt ? `Last sweep finished ${state.finishedAt.slice(0, 10)}.` : "No sweep has run yet.";
	}
	return `A sweep is under way (${state.phase === "check" ? "checking links" : "reading content"}).`;
}

export async function buildWidget(
	ctx: PluginContext,
	state: SweepState,
	requestedAt: string | null,
): Promise<{ blocks: Block[] }> {
	const counts = await countLinks(ctx);

	if (counts.total === 0) {
		return {
			blocks: [
				{
					type: "empty",
					icon: "link",
					title: "Nothing checked yet",
					description:
						state.phase === "done" && !state.finishedAt && !requestedAt
							? "The first sweep runs on the schedule in Link check settings."
							: progress(state, requestedAt),
				},
			],
		};
	}

	return {
		blocks: [
			{
				type: "stats",
				items: [
					{ label: "Broken", value: String(counts.broken) },
					{ label: "Redirects", value: String(counts.redirect) },
					{ label: "Checked", value: String(counts.total) },
				],
			},
			{ type: "context", text: progress(state, requestedAt) },
		],
	};
}

/** What the report shows right after "Run a full sweep now". */
export function buildSweepRequested(): { blocks: Block[] } {
	return {
		blocks: [
			{ type: "header", text: "Link report" },
			{
				type: "context",
				text: "A full sweep has been requested. It starts with the next run of the site's cron trigger; reload this page to follow it.",
			},
		],
	};
}

/**
 * Reported targets, one row each, with the first place it is linked from
 * and how many more there are. A table row per place would let one link
 * repeated across a few hundred entries push the page past emdash's Block
 * Kit limits, and emdash then rejects the whole report.
 */
export async function buildReportPage(ctx: PluginContext): Promise<{ blocks: Block[] }> {
	const counts = await countLinks(ctx);
	const findings = await ctx.storage.checks.query({ where: { finding: { in: FINDINGS } }, limit: REPORT_LIMIT });
	const checks = findings.items
		.map(({ data }) => data as CheckRow)
		.sort((a, b) => a.state.localeCompare(b.state) || a.target.localeCompare(b.target));

	if (checks.length === 0) {
		return {
			blocks: [
				{ type: "header", text: "Link report" },
				{
					type: "empty",
					icon: "check",
					title: counts.total === 0 ? "Nothing checked yet" : "No problems found",
					description:
						counts.total === 0
							? "The first sweep runs on the schedule in Link check settings."
							: `${counts.total} links checked, none broken.`,
				},
			],
		};
	}

	const multilingual = new Set(checks.map((check) => check.places?.[0]?.locale ?? null)).size > 1;
	const reported = counts.broken + counts.redirect;

	return {
		blocks: [
			{ type: "header", text: "Link report" },
			{
				type: "stats",
				items: [
					{ label: "Broken", value: String(counts.broken) },
					{ label: "Redirects", value: String(counts.redirect) },
					{ label: "Unresolved", value: String(counts.unknown) },
					{ label: "Checked", value: String(counts.total) },
				],
			},
			...(reported > checks.length
				? [{ type: "context", text: `Showing ${checks.length} of ${reported} findings.` }]
				: []),
			{
				type: "table",
				columns: [
					{ key: "state", label: "State" },
					{ key: "status", label: "Status" },
					{ key: "url", label: "Link" },
					{ key: "entry", label: "Found in" },
					...(multilingual ? [{ key: "locale", label: "Language" }] : []),
					{ key: "where", label: "Field" },
					{ key: "since", label: "First seen" },
				],
				rows: checks.map((check) => {
					const first = check.places?.[0];
					const more = (check.placeCount ?? 0) - 1;
					return {
						state: check.state,
						status: check.status === null ? "—" : String(check.status),
						url: first?.url ?? check.target,
						entry: first
							? `${first.collection}/${first.entrySlug ?? first.entryId}${more > 0 ? ` +${more} more` : ""}`
							: "—",
						locale: first?.locale ?? "",
						where: first?.path ?? "",
						since: (check.firstSeenAt ?? check.checkedAt).slice(0, 10),
					};
				}),
				page_action_id: REPORT_PAGE_ACTION,
			},
			{
				type: "actions",
				elements: [{ type: "button", action_id: "sweep_now", label: "Run a full sweep now" }],
			},
		],
	};
}

export function buildSettingsPage(settings: Settings): { blocks: Block[] } {
	return {
		blocks: [
			{ type: "header", text: "Link check settings" },
			{
				type: "context",
				text: "Every collection on the site is checked.",
			},
			{
				type: "form",
				submit: { label: "Save", action_id: "save_settings" },
				fields: [
					{
						type: "number_input",
						action_id: "batchSize",
						label: "Entries per step",
						min: 1,
						max: 100,
						initial_value: settings.batchSize,
					},
					{
						type: "text_input",
						action_id: "schedule",
						label: "Schedule (cron)",
						initial_value: settings.schedule,
					},
					{
						type: "toggle",
						action_id: "checkExternal",
						label: "Check outbound links",
						initial_value: settings.checkExternal,
					},
					{
						type: "number_input",
						action_id: "failureThreshold",
						label: "Failures before reporting",
						min: 1,
						max: 10,
						initial_value: settings.failureThreshold,
					},
				],
			},
		],
	};
}
