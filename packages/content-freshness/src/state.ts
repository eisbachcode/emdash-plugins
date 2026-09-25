/**
 * Everything the audit remembers between runs, under one KV key: one read
 * and at most one write per run, however many collections the site has.
 */

import type { PluginContext } from "emdash/plugin";

import type { Settings } from "./settings.js";

export const STATE_KEY = "state";

/** The recurring audit. `ctx.cron.schedule()` upserts on this name. */
export const AUDIT_TASK = "audit";

export interface Sweep {
	/** Rows written by this sweep carry this as `seenIn`; older ones are removed at the end. */
	startedAt: string;
	/** The collections as they were when the sweep started, walked in order. */
	collections: string[];
	index: number;
	/** `content.list` cursor within `collections[index]`. */
	cursor: string | null;
	phase: "audit" | "cleanup";
}

export interface State {
	sweep: Sweep | null;
	lastFinishedAt: string | null;
	/** The expression the recurring audit was last scheduled with. */
	scheduledAs: string | null;
}

const EMPTY: State = { sweep: null, lastFinishedAt: null, scheduledAs: null };

export async function readState(ctx: PluginContext): Promise<State> {
	const stored = await ctx.kv.get<Partial<State>>(STATE_KEY);
	return { ...EMPTY, ...stored };
}

export async function writeState(ctx: PluginContext, state: State): Promise<void> {
	await ctx.kv.set(STATE_KEY, state);
}

/**
 * Register the recurring audit unless it already runs on `settings.schedule`.
 *
 * `plugin:activate` fires only when a plugin is enabled or installed at
 * runtime. A plugin listed in `astro.config.mjs` is active from the start
 * and never sees it, so the admin surfaces call this too. Returns whether
 * `state` changed and needs writing.
 */
export async function ensureScheduled(ctx: PluginContext, settings: Settings, state: State): Promise<boolean> {
	if (state.scheduledAs === settings.schedule || !ctx.cron) return false;
	await ctx.cron.schedule(AUDIT_TASK, { schedule: settings.schedule });
	state.scheduledAs = settings.schedule;
	return true;
}
