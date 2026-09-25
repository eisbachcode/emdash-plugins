/**
 * Block Kit surfaces: report page, settings form, dashboard widget.
 */

import { listCollections } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext } from "emdash/plugin";

import { collectionsWithoutUrlPattern } from "./routing.js";
import { readSettings } from "./settings.js";
import type { StoredFinding } from "./sweep.js";

type Block = Record<string, unknown>;

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

export interface Counts {
	high: number;
	medium: number;
	low: number;
	total: number;
}

export async function countFindings(ctx: PluginContext): Promise<Counts> {
	const [high, medium, low, total] = await Promise.all([
		ctx.storage.findings.count({ severity: "high" }),
		ctx.storage.findings.count({ severity: "medium" }),
		ctx.storage.findings.count({ severity: "low" }),
		ctx.storage.findings.count(),
	]);
	return { high, medium, low, total };
}

/** A warning about collections whose public URLs EmDash gets wrong, or nothing. */
async function urlPatternBanner(ctx: PluginContext, detail: boolean): Promise<Block[]> {
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

export async function buildWidget(ctx: PluginContext): Promise<{ blocks: Block[] }> {
	const counts = await countFindings(ctx);
	const finished = await ctx.kv.get<string>("state:lastSweepFinishedAt");
	const banner = await urlPatternBanner(ctx, false);

	if (counts.total === 0) {
		if (banner.length > 0) return { blocks: banner };
		return {
			blocks: [
				{
					type: "empty",
					icon: "check",
					title: finished ? "Everything current" : "First audit pending",
					description: finished ? `Last audit ${finished.slice(0, 10)}.` : "Runs on the next scheduled sweep.",
				},
			],
		};
	}

	return {
		blocks: [
			...banner,
			{
				type: "stats",
				stats: [
					{ label: "Urgent", value: String(counts.high) },
					{ label: "Should fix", value: String(counts.medium) },
					{ label: "Nice to fix", value: String(counts.low) },
				],
			},
			{ type: "context", text: finished ? `Last audit ${finished.slice(0, 10)}` : "Audit in progress" },
		],
	};
}

export async function buildReportPage(ctx: PluginContext): Promise<{ blocks: Block[] }> {
	const banner = await urlPatternBanner(ctx, true);
	const counts = await countFindings(ctx);
	const stored = await ctx.storage.findings.query({ limit: 200 });
	const rows = stored.items
		.map(({ data }) => data as StoredFinding)
		.sort(
			(a, b) =>
				SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
				a.collection.localeCompare(b.collection) ||
				(a.slug ?? a.entryId).localeCompare(b.slug ?? b.entryId),
		);

	const multilingual = new Set(rows.map((row) => row.locale ?? null)).size > 1;

	if (rows.length === 0) {
		return {
			blocks: [
				{ type: "header", text: "Content freshness" },
				...banner,
				{
					type: "empty",
					icon: "check",
					title: "Nothing needs attention",
					description: "No stale entries, no missing descriptions, no overdue schedules.",
				},
			],
		};
	}

	return {
		blocks: [
			{ type: "header", text: "Content freshness" },
			...banner,
			{
				type: "stats",
				stats: [
					{ label: "Urgent", value: String(counts.high) },
					{ label: "Should fix", value: String(counts.medium) },
					{ label: "Nice to fix", value: String(counts.low) },
					{ label: "Total", value: String(counts.total) },
				],
			},
			{
				type: "table",
				columns: [
					{ key: "severity", label: "Priority" },
					{ key: "entry", label: "Entry" },
					...(multilingual ? [{ key: "locale", label: "Language" }] : []),
					{ key: "collection", label: "Collection" },
					{ key: "detail", label: "Finding" },
					{ key: "updated", label: "Last touched" },
				],
				rows: rows.map((row) => ({
					severity: row.severity,
					entry: row.slug ?? row.entryId,
					locale: row.locale ?? "",
					collection: row.collection,
					detail: row.detail,
					updated: row.entryUpdatedAt.slice(0, 10),
				})),
			},
			{
				type: "actions",
				elements: [{ type: "button", action_id: "audit_now", label: "Re-run the audit now" }],
			},
		],
	};
}

export async function buildSettingsPage(ctx: PluginContext): Promise<{ blocks: Block[] }> {
	const settings = await readSettings(ctx);
	return {
		blocks: [
			{ type: "header", text: "Freshness settings" },
			{
				type: "context",
				text: "Every collection on the site is audited.",
			},
			{
				type: "form",
				action_id: "save_settings",
				elements: [
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
						max: 200,
						initial_value: settings.pageSize,
					},
					{ type: "text_input", action_id: "schedule", label: "Schedule (cron)", initial_value: settings.schedule },
				],
			},
		],
	};
}
