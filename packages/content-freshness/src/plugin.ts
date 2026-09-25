/**
 * content-freshness — scheduled staleness audit for EmDash content.
 *
 * Standard plugin format: one entry point for both trusted (in-process,
 * `plugins: []`) and sandboxed mode. Logic lives in the sibling modules.
 */

import { hasRole, ROLE } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { changedEntry, deletedEntry, forget, reevaluate } from "./hooks.js";
import {
	AUDIT_NOW_ACTION,
	buildReportPage,
	buildSettingsPage,
	buildWidget,
	countFindings,
	FIRST_PAGE_ACTION,
	PAGE_ACTION,
	SAVE_SETTINGS_ACTION,
} from "./report.js";
import { applyForm, readSettings, SETTINGS_KEY } from "./settings.js";
import { ensureScheduled, readState, writeState } from "./state.js";
import { AUDIT_NOW_TASK, runAudit } from "./sweep.js";

interface AdminInteraction {
	type: string;
	page?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}

/** Settings and state, with the recurring audit registered if it was not yet. */
async function loadAdmin(ctx: PluginContext) {
	const [settings, state] = await Promise.all([readSettings(ctx), readState(ctx)]);
	if (await ensureScheduled(ctx, settings, state)) await writeState(ctx, state);
	return { settings, state };
}

function cursorOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const cursor = (value as { cursor?: unknown }).cursor;
	return typeof cursor === "string" && cursor ? cursor : undefined;
}

/** Re-evaluate one entry after a state change. Never fails the editor's action. */
async function refresh(ctx: PluginContext, event: unknown): Promise<void> {
	const ref = changedEntry(event);
	if (!ref) return;
	try {
		await reevaluate(ctx, ref);
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
				await loadAdmin(ctx);
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
					await forget(ctx, ref);
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

				if (interaction.type === "page_load") {
					const { settings, state } = await loadAdmin(ctx);
					if (interaction.page === "widget:summary") return buildWidget(ctx, state);
					if (interaction.page === "/settings") return buildSettingsPage(settings);
					return buildReportPage(ctx, state);
				}

				if (interaction.type === "form_submit" && interaction.action_id === SAVE_SETTINGS_ACTION) {
					return saveSettings(ctx, routeCtx.user, interaction.values ?? {});
				}

				if (interaction.type === "block_action") {
					if (interaction.action_id === PAGE_ACTION) {
						return buildReportPage(ctx, await readState(ctx), cursorOf(interaction.value));
					}
					if (interaction.action_id === FIRST_PAGE_ACTION) {
						return buildReportPage(ctx, await readState(ctx));
					}
					if (interaction.action_id === AUDIT_NOW_ACTION) {
						await ctx.cron?.schedule(AUDIT_NOW_TASK, { schedule: new Date(Date.now() + 1000).toISOString() });
						const state = await readState(ctx);
						return {
							...(await buildReportPage(ctx, state)),
							toast: {
								message: state.sweep
									? "The running audit continues with the next scheduled run."
									: "The audit starts with the next scheduled run.",
								type: "info",
							},
						};
					}
				}

				return { blocks: [] };
			},
		},

		status: {
			handler: async (_routeCtx, ctx) => {
				const [state, counts] = await Promise.all([readState(ctx), countFindings(ctx)]);
				return {
					lastSweepFinishedAt: state.lastFinishedAt,
					sweepInProgress: state.sweep !== null,
					counts,
				};
			},
		},
	},
} satisfies SandboxedPlugin;

async function saveSettings(
	ctx: PluginContext,
	user: Parameters<typeof hasRole>[0],
	values: Record<string, unknown>,
) {
	const [current, state] = await Promise.all([readSettings(ctx), readState(ctx)]);
	if (!hasRole(user, ROLE.ADMIN)) {
		return {
			...buildSettingsPage(current),
			toast: { message: "Only an administrator can change these settings.", type: "error" as const },
		};
	}

	const next = applyForm(current, values);
	// Schedule first: an expression the scheduler rejects is never stored.
	try {
		await ensureScheduled(ctx, next, state);
	} catch {
		return {
			...buildSettingsPage(current),
			toast: { message: `"${next.schedule}" is not a cron expression the scheduler accepts.`, type: "error" as const },
		};
	}
	await Promise.all([ctx.kv.set(SETTINGS_KEY, next), writeState(ctx, state)]);
	return { ...buildSettingsPage(next), toast: { message: "Settings saved.", type: "success" as const } };
}

/**
 * `satisfies` above for the per-hook inference (`event` typed by hook
 * name), and an explicit type on the export because the inferred shape
 * cannot be named from a pnpm nested path — `tsc` rejects the generated
 * declaration with TS2742 otherwise.
 */
export default plugin as SandboxedPlugin;
