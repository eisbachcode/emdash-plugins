/**
 * content-link-check — scheduled link audit for EmDash content.
 *
 * Standard plugin format: this one file is the entry point in both
 * trusted (in-process, `plugins: []`) and sandboxed (`sandboxed: []`)
 * mode. The logic lives in the sibling modules; this is wiring.
 */

import {
	followUpPending,
	hasRole,
	isFollowUp,
	ROLE,
	scheduleFollowUp,
	type SweepChain,
} from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { Budget } from "./budget.js";
import {
	buildReportPage,
	buildSettingsPage,
	buildSweepRequested,
	buildWidget,
	countLinks,
	REPORT_PAGE_ACTION,
} from "./report.js";
import { mergeSettings, readSettings, SETTINGS_KEY, type Settings } from "./settings.js";
import { loadAll } from "./state.js";
import { requestSweep, sweepTick } from "./sweep.js";

interface AdminInteraction {
	type: string;
	page?: string;
	action_id?: string;
	values?: Record<string, unknown>;
}

/**
 * The recurring task, and the one-shot the "Sweep now" button schedules.
 *
 * They cannot share a name. `ctx.cron.schedule()` upserts on (plugin, task
 * name), so scheduling the recurring name with a one-shot timestamp would
 * replace the nightly sweep with a task that runs once and never again. The
 * button schedules its own name instead, and the cron handler answers to
 * both.
 */
const SWEEP_TASK = "sweep";
const SWEEP_NOW_TASK = "sweep-now";

/**
 * A sweep carries on in follow-up runs until it is done. Each run is one
 * small step, so the cap is about a day of runs on a per-minute cron
 * trigger; a sweep that hits it carries on from its next scheduled start.
 */
const CHAIN: SweepChain = { next: ["sweep-next-a", "sweep-next-b"], maxSteps: 1400 };

const plugin = {
	hooks: {
		/**
		 * Register the sweep when the plugin is switched on at runtime. A plugin
		 * listed in the Astro config is never switched on this way; see
		 * `ensureScheduled` for how that one gets its sweep.
		 */
		"plugin:activate": {
			handler: async (_event, ctx) => scheduleSweep(ctx, (await readSettings(ctx)).schedule),
		},

		cron: {
			handler: async (event, ctx) => {
				const start = event.name === SWEEP_TASK || event.name === SWEEP_NOW_TASK;
				if (!start && !isFollowUp(CHAIN, event.name)) return;

				const budget = new Budget();
				if (start) {
					budget.spend();
					// A follow-up already waiting means a sweep is under way.
					if (await followUpPending(ctx, CHAIN)) return;
				}
				if (!(await sweepTick(ctx, budget, { start }))) return;
				// The follow-up call the run set aside pays for the warning when there is no follow-up.
				if (!(await scheduleFollowUp(ctx, CHAIN, event))) {
					ctx.log.warn(`Sweep paused after ${CHAIN.maxSteps} runs; it carries on from its next scheduled start`);
				}
			},
		},

		/** A site whose admin nobody opens still gets its sweep; see `ensureScheduled`. */
		"content:afterSave": {
			errorPolicy: "continue",
			handler: async (_event, ctx) => ensureScheduled(ctx),
		},
		"content:afterPublish": {
			errorPolicy: "continue",
			handler: async (_event, ctx) => ensureScheduled(ctx),
		},
	},

	routes: {
		/** Every Block Kit surface arrives here. */
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
					const { settings, state, requestedAt } = await loadAll(ctx);
					await ensureScheduled(ctx, settings);
					if (interaction.page === "widget:summary") return buildWidget(ctx, state, requestedAt);
					if (interaction.page === "/settings") return buildSettingsPage(settings);
					return buildReportPage(ctx);
				}

				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					const current = await readSettings(ctx);
					if (!hasRole(routeCtx.user, ROLE.ADMIN)) {
						return {
							...buildSettingsPage(current),
							toast: { message: "Only an administrator can change these settings.", type: "error" },
						};
					}
					const next = mergeSettings(current, interaction.values ?? {});
					// Scheduled before anything is stored: emdash rejects a cron
					// expression it cannot parse, and a saved value the sweep does not
					// run on would be worse than a refused save.
					try {
						await scheduleSweep(ctx, next.schedule);
					} catch {
						return {
							...buildSettingsPage(current),
							toast: { message: "That schedule is not a cron expression emdash accepts. Nothing was saved.", type: "error" },
						};
					}
					await ctx.kv.set(SETTINGS_KEY, next);
					return buildSettingsPage(next);
				}

				if (interaction.type === "block_action") {
					if (interaction.action_id === "sweep_now") {
						await requestSweep(ctx);
						await ctx.cron?.schedule(SWEEP_NOW_TASK, { schedule: new Date(Date.now() + 1000).toISOString() });
						return buildSweepRequested();
					}
					if (interaction.action_id === REPORT_PAGE_ACTION) return buildReportPage(ctx);
				}

				return { blocks: [] };
			},
		},

		/** JSON counts, for a status check or an external dashboard. */
		status: {
			handler: async (_routeCtx, ctx) => {
				const [{ state }, counts] = await Promise.all([loadAll(ctx), countLinks(ctx)]);
				return {
					phase: state.phase,
					startedAt: state.startedAt,
					finishedAt: state.finishedAt,
					collections: state.collections,
					counts,
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

async function scheduleSweep(ctx: PluginContext, schedule: string): Promise<void> {
	await ctx.cron?.schedule(SWEEP_TASK, { schedule });
}

/** Set once this isolate has seen the sweep registered on the saved schedule. */
let sweepConfirmed = false;

/**
 * Register the nightly sweep if it is missing or runs on another schedule
 * than the saved one. emdash only fires `plugin:activate` when a plugin is
 * switched on at runtime, never for one listed in the Astro config, and the
 * manifest cannot declare a schedule. So admin page loads and saves check,
 * once per isolate. A failure here never costs the caller the work it came
 * for.
 */
async function ensureScheduled(ctx: PluginContext, known?: Settings): Promise<void> {
	if (sweepConfirmed || !ctx.cron) return;
	try {
		const [tasks, settings] = await Promise.all([ctx.cron.list(), known ?? readSettings(ctx)]);
		const sweep = tasks.find((task) => task.name === SWEEP_TASK);
		if (sweep?.schedule !== settings.schedule) await scheduleSweep(ctx, settings.schedule);
		sweepConfirmed = true;
	} catch {
		// Logging would spend a bridge call the caller may not have; the next
		// load or save tries again.
	}
}
