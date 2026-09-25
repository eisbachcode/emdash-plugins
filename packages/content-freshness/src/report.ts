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
	ButtonElement,
	FormBlock,
	SelectElement,
	StatsBlock,
} from "@emdash-cms/blocks";
import { listCollections, type PluginCollectionInfo } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext } from "emdash/plugin";

import { describeHit } from "./describe.js";
import type { EntryFindings } from "./findings.js";
import { t, type Lang, type MessageKey } from "./i18n.js";
import { collectionsWithoutUrlPattern } from "./routing.js";
import { RANK } from "./rules.js";
import type { Settings } from "./settings.js";
import type { State } from "./state.js";

export const VIEW_ACTION = "report_view";
export const AUDIT_NOW_ACTION = "audit_now";
export const SAVE_SETTINGS_ACTION = "save_settings";

/** Entries per report page. Three blocks each keeps a page well inside Block Kit's limits. */
const PAGE_ENTRIES = 25;

const PRIORITY: Record<number, MessageKey> = {
	[RANK.high]: "priorityHigh",
	[RANK.medium]: "priorityMedium",
	[RANK.low]: "priorityLow",
};

/**
 * What the report shows. A block action carries only its own value, so every
 * control that changes the view carries the whole view: a filter keeps the
 * other filter, and paging keeps both.
 */
export interface ReportView {
	collection: string | null;
	rank: number | null;
	cursor: string | null;
}

export const FIRST_VIEW: ReportView = { collection: null, rank: null, cursor: null };

/** The view a control sent: a JSON string from a select, an object from a button. */
export function viewFrom(value: unknown): ReportView {
	let source: unknown = value;
	if (typeof value === "string") {
		try {
			source = JSON.parse(value);
		} catch {
			return FIRST_VIEW;
		}
	}
	if (typeof source !== "object" || source === null) return FIRST_VIEW;
	const { collection, rank, cursor } = source as Record<string, unknown>;
	return {
		collection: typeof collection === "string" && collection ? collection : null,
		rank: typeof rank === "number" && Object.hasOwn(PRIORITY, rank) ? rank : null,
		cursor: typeof cursor === "string" && cursor ? cursor : null,
	};
}

function viewValue(view: ReportView): string {
	return JSON.stringify({ collection: view.collection, rank: view.rank, cursor: view.cursor });
}

/** Entries by the severity of their most urgent finding. */
export interface Counts {
	high: number;
	medium: number;
	low: number;
	total: number;
}

export async function countFindings(ctx: PluginContext): Promise<Counts> {
	const [high, medium, low] = await Promise.all(
		[RANK.high, RANK.medium, RANK.low].map((rank) => ctx.storage.findings.count({ rank })),
	);
	return { high: high ?? 0, medium: medium ?? 0, low: low ?? 0, total: (high ?? 0) + (medium ?? 0) + (low ?? 0) };
}

function statsBlock(lang: Lang, counts: Counts, withTotal: boolean): StatsBlock {
	return {
		type: "stats",
		items: [
			{ label: t(lang, "priorityHigh"), value: counts.high },
			{ label: t(lang, "priorityMedium"), value: counts.medium },
			{ label: t(lang, "priorityLow"), value: counts.low },
			...(withTotal ? [{ label: t(lang, "statEntries"), value: counts.total }] : []),
		],
	};
}

function auditStatus(lang: Lang, state: State): string {
	if (state.sweep) return t(lang, "auditRunning", { date: state.sweep.startedAt.slice(0, 10) });
	if (state.lastFinishedAt) return t(lang, "auditLast", { date: state.lastFinishedAt.slice(0, 10) });
	return t(lang, "auditPending");
}

/** A warning about collections whose public URLs EmDash gets wrong, or nothing. */
function urlPatternBanner(lang: Lang, collections: PluginCollectionInfo[], detail: boolean): BannerBlock[] {
	const missing = collectionsWithoutUrlPattern(collections);
	if (missing.length === 0) return [];
	const names = missing.map((collection) => collection.label || collection.slug).join(", ");
	return [
		{
			type: "banner",
			variant: "alert",
			title: t(lang, "urlPatternTitle", { names }),
			description: t(lang, detail ? "urlPatternDetail" : "urlPatternShort"),
		},
	];
}

export async function buildWidget(ctx: PluginContext, state: State, lang: Lang): Promise<BlockResponse> {
	const [counts, collections] = await Promise.all([countFindings(ctx), listCollections(ctx)]);
	const banner = urlPatternBanner(lang, collections, false);

	if (counts.total === 0) {
		if (banner.length > 0) return { blocks: banner };
		return {
			blocks: [
				{
					type: "empty",
					title: t(lang, state.lastFinishedAt ? "widgetClear" : "auditPending"),
					description: state.lastFinishedAt
						? t(lang, "widgetLastAudit", { date: state.lastFinishedAt.slice(0, 10) })
						: t(lang, "widgetPending"),
				},
			],
		};
	}

	return {
		blocks: [
			...banner,
			statsBlock(lang, counts, false),
			{ type: "context", text: auditStatus(lang, state) },
			{
				type: "actions",
				elements: [
					{ type: "link", label: t(lang, "openReport"), target: { kind: "plugin-page", path: "/report" } },
				],
			},
		],
	};
}

/**
 * A page of rows for `view`, most urgent first, and whether it is a later
 * page.
 *
 * Storage continues from the cursor row's current rank. When that row has
 * gone since the previous page, because its entry was fixed or deleted,
 * nothing follows it and the page comes back empty. That, and a cursor
 * storage cannot decode, fall back to the first page of the same filter.
 */
async function findingsPage(ctx: PluginContext, view: ReportView) {
	const where: Record<string, string | number> = {};
	if (view.collection) where.collection = view.collection;
	if (view.rank !== null) where.rank = view.rank;
	const query = { where, orderBy: { rank: "asc" as const }, limit: PAGE_ENTRIES };
	if (view.cursor) {
		try {
			const page = await ctx.storage.findings.query({ ...query, cursor: view.cursor });
			if (page.items.length > 0) return { page, later: true };
		} catch {
			// Undecodable cursor.
		}
	}
	return { page: await ctx.storage.findings.query(query), later: false };
}

function filters(lang: Lang, view: ReportView, collections: PluginCollectionInfo[]): ActionsBlock {
	const collection: SelectElement = {
		type: "select",
		action_id: VIEW_ACTION,
		label: t(lang, "filterCollection"),
		initial_value: viewValue({ ...view, cursor: null }),
		options: [
			{ label: t(lang, "filterAll"), value: viewValue({ ...view, collection: null, cursor: null }) },
			...collections.map((item) => ({
				label: item.label || item.slug,
				value: viewValue({ ...view, collection: item.slug, cursor: null }),
			})),
		],
	};
	const priority: SelectElement = {
		type: "select",
		action_id: VIEW_ACTION,
		label: t(lang, "filterPriority"),
		initial_value: viewValue({ ...view, cursor: null }),
		options: [
			{ label: t(lang, "filterAll"), value: viewValue({ ...view, rank: null, cursor: null }) },
			...[RANK.high, RANK.medium, RANK.low].map((rank) => ({
				label: t(lang, PRIORITY[rank]!),
				value: viewValue({ ...view, rank, cursor: null }),
			})),
		],
	};
	return { type: "actions", elements: [collection, priority] };
}

function entryBlocks(lang: Lang, row: EntryFindings, collectionLabel: string, withLocale: boolean): Block[] {
	const name = row.title ?? row.slug ?? row.entryId;
	const where = [name, collectionLabel, ...(withLocale && row.locale ? [row.locale] : [])].join(" · ");
	const findings = row.hits.map((hit) => describeHit(lang, hit)).join(" ");
	return [
		{
			type: "section",
			text: where,
			accessory: {
				type: "link",
				label: t(lang, "open"),
				target: {
					kind: "content",
					collection: row.collection,
					id: row.entryId,
					...(row.locale ? { locale: row.locale } : {}),
				},
			},
		},
		{ type: "context", text: `${t(lang, PRIORITY[row.rank] ?? "priorityLow")}: ${findings}` },
		{ type: "divider" },
	];
}

export async function buildReportPage(
	ctx: PluginContext,
	state: State,
	lang: Lang,
	view: ReportView = FIRST_VIEW,
): Promise<BlockResponse> {
	const [collections, counts, { page, later }] = await Promise.all([
		listCollections(ctx),
		countFindings(ctx),
		findingsPage(ctx, view),
	]);
	const banner = urlPatternBanner(lang, collections, true);
	const auditNow: ButtonElement = {
		type: "button",
		action_id: AUDIT_NOW_ACTION,
		label: t(lang, "auditNow"),
		value: viewValue(view),
	};

	if (counts.total === 0) {
		return {
			blocks: [
				{ type: "header", text: t(lang, "reportTitle") },
				...banner,
				{ type: "empty", title: t(lang, "nothingTitle"), description: t(lang, "nothingText") },
				{ type: "context", text: auditStatus(lang, state) },
				{ type: "actions", elements: [auditNow] },
			],
		};
	}

	const labels = new Map(collections.map((item) => [item.slug, item.label || item.slug]));
	const rows = page.items.map(({ data }) => data as EntryFindings);
	const withLocale = new Set(rows.map((row) => row.locale ?? null)).size > 1;
	const paging: ButtonElement[] = [
		...(later ? [{ type: "button" as const, action_id: VIEW_ACTION, label: t(lang, "firstPage"), value: { ...view, cursor: null } }] : []),
		...(page.hasMore && page.cursor
			? [{ type: "button" as const, action_id: VIEW_ACTION, label: t(lang, "nextPage"), value: { ...view, cursor: page.cursor } }]
			: []),
	];

	return {
		blocks: [
			{ type: "header", text: t(lang, "reportTitle") },
			...banner,
			statsBlock(lang, counts, true),
			{ type: "context", text: auditStatus(lang, state) },
			filters(lang, view, collections),
			...(rows.length === 0
				? [{ type: "context" as const, text: t(lang, "noMatch") }]
				: rows.flatMap((row) => entryBlocks(lang, row, labels.get(row.collection) ?? row.collection, withLocale))),
			{ type: "actions", elements: [...paging, auditNow] },
		],
	};
}

export function buildSettingsPage(settings: Settings, lang: Lang): BlockResponse {
	const form: FormBlock = {
		type: "form",
		fields: [
			{
				type: "number_input",
				action_id: "staleMonths",
				label: t(lang, "staleMonths"),
				min: 1,
				max: 120,
				initial_value: settings.staleMonths,
			},
			{
				type: "number_input",
				action_id: "draftMonths",
				label: t(lang, "draftMonths"),
				min: 1,
				max: 120,
				initial_value: settings.draftMonths,
			},
			{
				type: "number_input",
				action_id: "descriptionMin",
				label: t(lang, "descriptionMin"),
				min: 0,
				max: 300,
				initial_value: settings.descriptionMin,
			},
			{
				type: "number_input",
				action_id: "descriptionMax",
				label: t(lang, "descriptionMax"),
				min: 0,
				max: 300,
				initial_value: settings.descriptionMax,
			},
			{
				type: "toggle",
				action_id: "reportMissingDescriptions",
				label: t(lang, "reportMissing"),
				description: t(lang, "reportMissingHelp"),
				initial_value: settings.reportMissingDescriptions,
			},
			{
				type: "number_input",
				action_id: "pageSize",
				label: t(lang, "pageSize"),
				min: 1,
				max: 100,
				initial_value: settings.pageSize,
			},
			{ type: "text_input", action_id: "schedule", label: t(lang, "schedule"), initial_value: settings.schedule },
		],
		submit: { label: t(lang, "save"), action_id: SAVE_SETTINGS_ACTION },
	};
	return {
		blocks: [
			{ type: "header", text: t(lang, "settingsTitle") },
			{ type: "context", text: t(lang, "settingsIntro") },
			form,
		],
	};
}
