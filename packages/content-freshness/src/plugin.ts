/**
 * content-freshness — scheduled staleness audit for EmDash content.
 *
 * Standard plugin format: one entry point for both trusted (in-process,
 * `plugins: []`) and sandboxed mode. Logic lives in the sibling modules.
 */

import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { buildReportPage, buildSettingsPage, buildWidget, countFindings } from "./report.js";
import {
	followUpPending,
	hasRole,
	isFollowUp,
	listCollections,
	ROLE,
	scheduleFollowUp,
	type SweepChain,
} from "@eisbachcode/emdash-plugin-shared";
import { readSettings, writeSettings } from "./settings.js";
import { auditNextPage, finishSweep } from "./sweep.js";

async function collectionSlugs(ctx: PluginContext): Promise<string[]> {
	return (await listCollections(ctx)).map((collection) => collection.slug);
}

/** Audit the next page of the next unfinished collection. Returns whether there is more to do. */
async function auditStep(ctx: PluginContext): Promise<boolean> {
	const settings = await readSettings(ctx);
	const collections = await collectionSlugs(ctx);
	if (collections.length === 0) {
		ctx.log.warn("No collections to audit");
		return false;
	}

	const result = await auditNextPage(ctx, settings, collections);
	if (!result) {
		await finishSweep(ctx, collections);
		ctx.log.info("Freshness audit complete");
		return false;
	}
	ctx.log.info(`Audited ${result.entries} entries in ${result.collection}, ${result.found} findings`);
	return true;
}

interface AdminInteraction {
	type: string;
	page?: string;
	action_id?: string;
	values?: Record<string, unknown>;
}

/**
 * The recurring task, and the one-shot the "Audit now" button schedules.
 *
 * They cannot share a name. `ctx.cron.schedule()` upserts on (plugin, task
 * name), so scheduling the recurring name with a one-shot timestamp would
 * replace the recurring audit with a task that runs once and never again. The
 * button schedules its own name instead, and the cron handler answers to
 * both.
 */
const AUDIT_TASK = "audit";
const AUDIT_NOW_TASK = "audit-now";

/** An audit carries on in follow-up runs until it is done. 500 runs is 25,000 entries at the default page size. */
const CHAIN: SweepChain = { next: ["audit-next-a", "audit-next-b"], maxSteps: 500 };

const plugin = {
	hooks: {
		"plugin:activate": {
			handler: async (_event, ctx) => {
				const settings = await readSettings(ctx);
				await ctx.cron?.schedule(AUDIT_TASK, { schedule: settings.schedule });
				ctx.log.info(`Freshness audit scheduled: ${settings.schedule}`);
			},
		},

		cron: {
			handler: async (event, ctx) => {
				const starts = event.name === AUDIT_TASK || event.name === AUDIT_NOW_TASK;
				if (!starts && !isFollowUp(CHAIN, event.name)) return;
				// A follow-up already waiting means an audit is under way.
				if (starts && (await followUpPending(ctx, CHAIN))) return;

				if (!(await auditStep(ctx))) return;
				if (!(await scheduleFollowUp(ctx, CHAIN, event))) {
					ctx.log.warn(`Audit paused after ${CHAIN.maxSteps} runs; it continues at the next scheduled run`);
				}
			},
		},
	},

	routes: {
		admin: {
			// Without this the route resolves with no permission and dispatch
			// falls back to `plugins:manage`, which is administrators only, so
			// every editor sees the widget card and a permission error inside
			// it. `plugins:read` is editor and above. Settings submissions are
			// held to administrators inside the handler, because a route carries
			// one permission and this one serves both a report and a form.
			permission: "plugins:read",
			handler: async (routeCtx, ctx) => {
				const interaction = routeCtx.input as AdminInteraction;

				if (interaction.type === "page_load") {
					if (interaction.page === "widget:summary") return buildWidget(ctx);
					if (interaction.page === "/settings") return buildSettingsPage(ctx);
					return buildReportPage(ctx);
				}

				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					if (!hasRole(routeCtx.user, ROLE.ADMIN)) {
						return {
							...(await buildSettingsPage(ctx)),
							toast: { message: "Only an administrator can change these settings.", type: "error" },
						};
					}
					await writeSettings(ctx, interaction.values ?? {});
					const settings = await readSettings(ctx);
					// Re-register so a changed cron expression takes effect.
					await ctx.cron?.schedule(AUDIT_TASK, { schedule: settings.schedule });
					return buildSettingsPage(ctx);
				}

				if (interaction.type === "block_action" && interaction.action_id === "audit_now") {
					await finishSweep(ctx, await collectionSlugs(ctx));
					await ctx.cron?.schedule(AUDIT_NOW_TASK, { schedule: new Date(Date.now() + 1000).toISOString() });
					return buildReportPage(ctx);
				}

				return { blocks: [] };
			},
		},

		status: {
			handler: async (_routeCtx, ctx) => {
				return {
					collections: await collectionSlugs(ctx),
					lastSweepFinishedAt: await ctx.kv.get<string>("state:lastSweepFinishedAt"),
					counts: await countFindings(ctx),
				};
			},
		},
	},
} satisfies SandboxedPlugin;

/**
 * `satisfies` above for the per-hook inference (`event` typed by hook
 * name), and an explicit type on the export because the inferred shape
 * cannot be named from a pnpm nested path — `tsc` rejects the generated
 * declaration with TS2742 otherwise.
 */
export default plugin as SandboxedPlugin;
