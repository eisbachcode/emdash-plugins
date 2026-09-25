/**
 * Block Kit surfaces: report page, settings form, dashboard widget.
 *
 * Every block is typed with upstream's own interfaces, imported as types
 * only so nothing of `@emdash-cms/blocks` reaches the plugin bundle. The
 * host rejects a sandboxed response whose blocks do not validate, so a
 * wrong key must be a compile error.
 */

import type {
	ActionsBlock,
	BannerBlock,
	Block,
	BlockResponse,
	FormBlock,
	StatsBlock,
	TableBlock,
} from "@emdash-cms/blocks";
import { listCollections } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext } from "emdash/plugin";

import { describeHit } from "./describe.js";
import type { EntryFindings } from "./findings.js";
import { collectionsWithoutUrlPattern } from "./routing.js";
import type { Settings } from "./settings.js";
import type { State } from "./state.js";

export const PAGE_ACTION = "findings_page";
export const FIRST_PAGE_ACTION = "findings_first_page";
export const AUDIT_NOW_ACTION = "audit_now";
export const SAVE_SETTINGS_ACTION = "save_settings";

/** Rows per report page. Storage queries return at most 100. */
const PAGE_ROWS = 50;

const PRIORITY = ["Urgent", "Should fix", "Nice to fix"] as const;

export interface Counts {
	/** Entries by their most urgent finding: index 0 urgent, 1 should fix, 2 nice to fix. */
	byRank: [number, number, number];
	total: number;
}

export async function countFindings(ctx: PluginContext): Promise<Counts> {
	const byRank = (await Promise.all([0, 1, 2].map((rank) => ctx.storage.findings.count({ rank })))) as [
		number,
		number,
		number,
	];
	return { byRank, total: byRank[0] + byRank[1] + byRank[2] };
}

function statsBlock(counts: Counts, withTotal: boolean): StatsBlock {
	return {
		type: "stats",
		items: [
			...PRIORITY.map((label, rank) => ({ label, value: counts.byRank[rank] ?? 0 })),
			...(withTotal ? [{ label: "Entries", value: counts.total }] : []),
		],
	};
}

function auditStatus(state: State): string {
	if (state.sweep) return `Audit in progress since ${state.sweep.startedAt.slice(0, 10)}`;
	if (state.lastFinishedAt) return `Last audit ${state.lastFinishedAt.slice(0, 10)}`;
	return "First audit pending";
}

/** A warning about collections whose public URLs EmDash gets wrong, or nothing. */
async function urlPatternBanner(ctx: PluginContext, detail: boolean): Promise<BannerBlock[]> {
	const missing = collectionsWithoutUrlPattern(await listCollections(ctx));
	if (missing.length === 0) return [];
	const names = missing.map((collection) => collection.label || collection.slug).join(", ");
	const explanation =
		"EmDash links their entries as /{collection}/{slug} in the sitemap and the admin, which is wrong " +
		"unless the site uses exactly those routes. Set a URL pattern under Content Types, or switch off " +
		"routing for a collection that has no pages of its own.";
	return [
		{
			type: "banner",
			variant: "alert",
			title: `No URL pattern: ${names}`,
			description: detail ? explanation : "Sitemap links for these collections may be broken.",
		},
	];
}

export async function buildWidget(ctx: PluginContext, state: State): Promise<BlockResponse> {
	const [counts, banner] = await Promise.all([countFindings(ctx), urlPatternBanner(ctx, false)]);

	if (counts.total === 0) {
		if (banner.length > 0) return { blocks: banner };
		return {
			blocks: [
				{
					type: "empty",
					title: state.lastFinishedAt ? "Everything current" : "First audit pending",
					description: state.lastFinishedAt
						? `Last audit ${state.lastFinishedAt.slice(0, 10)}.`
						: "Runs on the next scheduled audit.",
				},
			],
		};
	}

	return {
		blocks: [...banner, statsBlock(counts, false), { type: "context", text: auditStatus(state) }],
	};
}

/**
 * A page of rows, most urgent first, and whether it is a later page. A
 * cursor storage rejects falls back to the first page.
 */
async function findingsPage(ctx: PluginContext, cursor: string | undefined) {
	const query = { orderBy: { rank: "asc" as const }, limit: PAGE_ROWS };
	if (cursor) {
		try {
			return { page: await ctx.storage.findings.query({ ...query, cursor }), later: true };
		} catch {
			// A cursor from the client that storage cannot decode.
		}
	}
	return { page: await ctx.storage.findings.query(query), later: false };
}

export async function buildReportPage(
	ctx: PluginContext,
	state: State,
	cursor?: string,
): Promise<BlockResponse> {
	const [banner, counts, { page, later }] = await Promise.all([
		urlPatternBanner(ctx, true),
		countFindings(ctx),
		findingsPage(ctx, cursor),
	]);
	const auditNow: ActionsBlock = {
		type: "actions",
		elements: [
			{ type: "button", action_id: AUDIT_NOW_ACTION, label: "Audit now" },
			...(later ? [{ type: "button" as const, action_id: FIRST_PAGE_ACTION, label: "First page" }] : []),
		],
	};

	if (counts.total === 0) {
		return {
			blocks: [
				{ type: "header", text: "Content freshness" },
				...banner,
				{
					type: "empty",
					title: "Nothing needs attention",
					description: "No stale entries, no missing descriptions, no overdue schedules.",
				},
				{ type: "context", text: auditStatus(state) },
				auditNow,
			],
		};
	}

	const rows = page.items.map(({ data }) => data as EntryFindings);
	const multilingual = new Set(rows.map((row) => row.locale ?? null)).size > 1;
	const table: TableBlock = {
		type: "table",
		page_action_id: PAGE_ACTION,
		columns: [
			{ key: "priority", label: "Priority", format: "badge" },
			{ key: "entry", label: "Entry" },
			...(multilingual ? [{ key: "locale", label: "Language" }] : []),
			{ key: "collection", label: "Collection" },
			{ key: "findings", label: "Findings" },
			{ key: "updated", label: "Last touched" },
		],
		rows: rows.map((row) => ({
			priority: PRIORITY[row.rank] ?? "",
			entry: row.slug ?? row.entryId,
			locale: row.locale ?? "",
			collection: row.collection,
			findings: row.hits.map(describeHit).join(" "),
			updated: row.entryUpdatedAt.slice(0, 10),
		})),
		...(page.hasMore && page.cursor ? { next_cursor: page.cursor } : {}),
	};

	const blocks: Block[] = [
		{ type: "header", text: "Content freshness" },
		...banner,
		statsBlock(counts, true),
		{ type: "context", text: auditStatus(state) },
		table,
		auditNow,
	];
	return { blocks };
}

export function buildSettingsPage(settings: Settings): BlockResponse {
	const form: FormBlock = {
		type: "form",
		fields: [
			{
				type: "number_input",
				action_id: "staleMonths",
				label: "Months before a published entry counts as stale",
				min: 1,
				max: 120,
				initial_value: settings.staleMonths,
			},
			{
				type: "number_input",
				action_id: "draftMonths",
				label: "Months before a draft counts as forgotten",
				min: 1,
				max: 120,
				initial_value: settings.draftMonths,
			},
			{
				type: "number_input",
				action_id: "descriptionMin",
				label: "Shortest acceptable SEO description",
				min: 0,
				max: 300,
				initial_value: settings.descriptionMin,
			},
			{
				type: "number_input",
				action_id: "descriptionMax",
				label: "Longest acceptable SEO description",
				min: 0,
				max: 300,
				initial_value: settings.descriptionMax,
			},
			{
				type: "toggle",
				action_id: "reportMissingDescriptions",
				label: "Report entries without an SEO description",
				description: "Switch off if your templates always render a description of their own.",
				initial_value: settings.reportMissingDescriptions,
			},
			{
				type: "number_input",
				action_id: "pageSize",
				label: "Entries per run",
				min: 1,
				max: 100,
				initial_value: settings.pageSize,
			},
			{ type: "text_input", action_id: "schedule", label: "Schedule (cron, UTC)", initial_value: settings.schedule },
		],
		submit: { label: "Save", action_id: SAVE_SETTINGS_ACTION },
	};
	return {
		blocks: [
			{ type: "header", text: "Freshness settings" },
			{ type: "context", text: "Every collection on the site is audited." },
			form,
		],
	};
}
