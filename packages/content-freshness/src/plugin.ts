/**
 * content-freshness — scheduled staleness audit for EmDash content.
 *
 * Standard plugin format: one entry point for both trusted (in-process,
 * `plugins: []`) and sandboxed mode. Logic lives in the sibling modules.
 */

import { hasRole, listCollections, ROLE } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { checkEntry, type PanelAction } from "./check.js";
import { forget } from "./findings.js";
import { changedEntry, deletedEntry } from "./hooks.js";
import { langOf, t, type Lang } from "./i18n.js";
import {
	AUDIT_NOW_ACTION,
	buildReportPage,
	buildSettingsPage,
	buildWidget,
	countFindings,
	SAVE_SETTINGS_ACTION,
	VIEW_ACTION,
	viewFrom,
} from "./report.js";
import { renderPanel, ruleOf, SET_ASIDE_ACTION, UNDO_ACTION } from "./panel.js";
import { ensureScheduled } from "./schedule.js";
import { applyForm, readSettings, readStoredSettings, writeStoredSettings } from "./settings.js";
import { readState } from "./state.js";
import { AUDIT_NOW_TASK, runAudit } from "./sweep.js";

interface AdminInteraction {
	type: string;
	page?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}

/**
 * Settings and state, with the recurring audit registered if it was not yet.
 * A failure to schedule is logged and the page still renders: the settings
 * page is where a bad schedule gets fixed.
 */
async function loadAdmin(ctx: PluginContext) {
	const [stored, state] = await Promise.all([readStoredSettings(ctx), readState(ctx)]);
	try {
		if (await ensureScheduled(ctx, stored)) await writeStoredSettings(ctx, stored);
	} catch (error) {
		ctx.log.warn(`Could not schedule the audit: ${errorMessage(error)}`);
	}
	return { settings: stored.settings, state };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}


/** Re-evaluate one entry after a state change. Never fails the editor's action. */
async function refresh(ctx: PluginContext, event: unknown): Promise<void> {
	const ref = changedEntry(event);
	if (!ref) return;
	try {
		await checkEntry(ctx, ref);
	} catch (error) {
		ctx.log.warn(`Could not re-check ${ref.collection}/${ref.id}: ${String(error)}`);
	}
}

const onStateChange = {
	errorPolicy: "continue" as const,
	handler: async (event: unknown, ctx: PluginContext) => refresh(ctx, event),
};

const plugin = {
	hooks: {
		"plugin:activate": {
			handler: async (_event, ctx) => {
				const stored = await readStoredSettings(ctx);
				await ensureScheduled(ctx, stored, true);
				await writeStoredSettings(ctx, stored);
			},
		},

		/**
		 * The recurring task, the one-shot the "Audit now" button schedules,
		 * and the follow-ups of a running sweep.
		 *
		 * The recurring task and the button's one-shot cannot share a name.
		 * `ctx.cron.schedule()` upserts on (plugin, task name), so scheduling
		 * the recurring name with a one-shot timestamp would replace the
		 * recurring audit with a task that runs once and never again.
		 */
		cron: {
			handler: async (event, ctx) => {
				await runAudit(ctx, event);
			},
		},

		"content:afterPublish": onStateChange,
		"content:afterUnpublish": onStateChange,
		"content:afterSchedule": onStateChange,
		"content:afterUnschedule": onStateChange,
		"content:afterRestore": onStateChange,
		"content:afterDelete": {
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				const ref = deletedEntry(event);
				if (!ref) return;
				try {
					await forget(ctx, ref, ref.permanent);
				} catch (error) {
					ctx.log.warn(`Could not drop ${ref.collection}/${ref.id}: ${String(error)}`);
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
				const lang = langOf(routeCtx.ui?.locale);

				if (interaction.type === "page_load") {
					const { settings, state } = await loadAdmin(ctx);
					if (interaction.page === "widget:summary") return buildWidget(ctx, state, lang, routeCtx.user?.id);
					if (interaction.page === "/settings") return buildSettingsPage(settings, lang, await listCollections(ctx));
					return buildReportPage(ctx, state, settings, lang);
				}

				if (interaction.type === "form_submit" && interaction.action_id === SAVE_SETTINGS_ACTION) {
					return saveSettings(ctx, routeCtx.user, interaction.values ?? {}, lang);
				}

				if (interaction.type === "block_action") {
					if (interaction.action_id === VIEW_ACTION) {
						const [state, settings] = await Promise.all([readState(ctx), readSettings(ctx)]);
						return buildReportPage(ctx, state, settings, lang, viewFrom(interaction.value));
					}
					if (interaction.action_id === AUDIT_NOW_ACTION) {
						await ctx.cron?.schedule(AUDIT_NOW_TASK, { schedule: new Date(Date.now() + 1000).toISOString() });
						const [state, settings] = await Promise.all([readState(ctx), readSettings(ctx)]);
						return {
							...(await buildReportPage(ctx, state, settings, lang, viewFrom(interaction.value))),
							toast: { message: t(lang, state.sweep ? "auditContinues" : "auditStarts"), type: "info" },
						};
					}
				}

				return { blocks: [] };
			},
		},

		// The entry editor's Freshness panel. Its own route because it needs a
		// lower permission than the report: `content:edit_own` is author and
		// above, and the host also checks that the user may edit this entry,
		// so an author sets aside findings on their own entries only.
		panel: {
			permission: "content:edit_own",
			handler: async (routeCtx, ctx) => {
				const ui = routeCtx.ui;
				if (ui?.surface !== "content-editor-panel") return { blocks: [] };
				const input = routeCtx.input as { type?: string; action_id?: string; value?: unknown };
				const rule = ruleOf(input.value);
				const kind =
					input.action_id === SET_ASIDE_ACTION ? "set-aside" : input.action_id === UNDO_ACTION ? "undo" : null;
				const action: PanelAction | undefined =
					input.type === "block_action" && rule && kind ? { kind, rule, by: routeCtx.user?.id ?? null } : undefined;
				const view = await checkEntry(ctx, { collection: ui.entry.collection, id: ui.entry.id }, action);
				return renderPanel(langOf(ui.locale), view);
			},
		},

		status: {
			handler: async (_routeCtx, ctx) => {
				const [state, counts] = await Promise.all([readState(ctx), countFindings(ctx)]);
				return {
					lastSweepFinishedAt: state.lastFinishedAt,
					sweepInProgress: state.sweep !== null,
					entriesBySeverity: counts,
				};
			},
		},
	},
} satisfies SandboxedPlugin;

async function saveSettings(
	ctx: PluginContext,
	user: Parameters<typeof hasRole>[0],
	values: Record<string, unknown>,
	lang: Lang,
) {
	const [stored, collections] = await Promise.all([readStoredSettings(ctx), listCollections(ctx)]);
	if (!hasRole(user, ROLE.ADMIN)) {
		return {
			...buildSettingsPage(stored.settings, lang, collections),
			toast: { message: t(lang, "adminOnly"), type: "error" as const },
		};
	}

	const shown = collections.map((collection) => collection.slug);
	const next = { settings: applyForm(stored.settings, values, shown), scheduledAs: stored.scheduledAs };
	// Schedule first: an expression the scheduler rejects is never stored.
	try {
		await ensureScheduled(ctx, next);
	} catch (error) {
		return {
			...buildSettingsPage(stored.settings, lang, collections),
			toast: { message: t(lang, "notSaved", { reason: errorMessage(error) }), type: "error" as const },
		};
	}
	await writeStoredSettings(ctx, next);
	return {
		...buildSettingsPage(next.settings, lang, collections),
		toast: { message: t(lang, "saved"), type: "success" as const },
	};
}

/**
 * `satisfies` above for the per-hook inference (`event` typed by hook
 * name), and an explicit type on the export because the inferred shape
 * cannot be named from a pnpm nested path — `tsc` rejects the generated
 * declaration with TS2742 otherwise.
 */
export default plugin as SandboxedPlugin;
