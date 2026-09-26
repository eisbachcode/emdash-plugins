/**
 * Where the sweep stands, stored in plugin KV as one object under `state`
 * so a tick reads it, together with the settings, in one bridge call.
 */

import type { PluginContext } from "emdash/plugin";

import { SETTINGS_KEY, settingsFrom, type Settings } from "./settings.js";

export const STATE_KEY = "state";

/**
 * When "Run a full sweep now" was last pressed. Its own key, because a
 * running tick rewrites the whole state object and would drop a request
 * written into it.
 */
export const REQUEST_KEY = "sweep-requested";

export interface SweepState {
	/**
	 * `begin` asks the next run to start a sweep, `walk` reads the content
	 * and records every link, `prune` deletes what the walk no longer found,
	 * `check` requests the targets not yet checked this sweep.
	 */
	phase: "begin" | "walk" | "prune" | "check" | "done";
	/** When the current or last sweep began. Null before the first one. */
	startedAt: string | null;
	finishedAt: string | null;
	/** Collection slugs, fixed when the sweep begins. */
	collections: string[];
	collectionIndex: number;
	cursor: string | null;
	/**
	 * Entries per walk step: the setting, shrunk when a page has more targets
	 * than a step may write, and grown back afterwards.
	 */
	pageSize: number | null;
	/** Hosts that answered 429, each with the time it may be asked again. */
	backoff: Record<string, string>;
}

export const IDLE_STATE: SweepState = {
	phase: "done",
	startedAt: null,
	finishedAt: null,
	collections: [],
	collectionIndex: 0,
	cursor: null,
	pageSize: null,
	backoff: {},
};

export function stateFrom(stored: unknown): SweepState {
	return { ...IDLE_STATE, ...((stored ?? {}) as Partial<SweepState>) };
}

/** Settings, sweep state and any pending sweep request, in one bridge call. */
export async function loadAll(
	ctx: PluginContext,
): Promise<{ settings: Settings; state: SweepState; requestedAt: string | null }> {
	const entries = new Map((await ctx.kv.list()).map(({ key, value }) => [key, value]));
	const requested = entries.get(REQUEST_KEY);
	return {
		settings: settingsFrom(entries.get(SETTINGS_KEY)),
		state: stateFrom(entries.get(STATE_KEY)),
		requestedAt: typeof requested === "string" ? requested : null,
	};
}

/** A fresh sweep over `collections`, starting now. */
export function beginSweep(state: SweepState, collections: string[], now: Date): SweepState {
	return {
		...state,
		phase: "walk",
		startedAt: now.toISOString(),
		finishedAt: null,
		collections,
		collectionIndex: 0,
		cursor: null,
		pageSize: null,
	};
}
