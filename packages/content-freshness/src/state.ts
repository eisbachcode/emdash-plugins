/**
 * Where the audit stands, under one KV key: one read and at most one write
 * per run, however many collections the site has. Only cron runs write it.
 */

import type { PluginContext } from "emdash/plugin";

export const STATE_KEY = "state";

export interface Sweep {
	/** Rows written by this sweep carry this as `seenIn`; older ones are removed at the end. */
	startedAt: string;
	/** The collections as they were when the sweep started, walked in order. */
	collections: string[];
	index: number;
	/** `content.list` cursor within `collections[index]`. */
	cursor: string | null;
	phase: "audit" | "cleanup";
	/** Each collection's `datetime` fields, read with the collection list, for the expiry rule. */
	dateFields?: Record<string, Array<{ slug: string; label: string }>>;
}

export interface State {
	sweep: Sweep | null;
	lastFinishedAt: string | null;
}

const EMPTY: State = { sweep: null, lastFinishedAt: null };

export async function readState(ctx: PluginContext): Promise<State> {
	const stored = await ctx.kv.get<Partial<State>>(STATE_KEY);
	return { ...EMPTY, ...stored };
}

export async function writeState(ctx: PluginContext, state: State): Promise<void> {
	await ctx.kv.set(STATE_KEY, state);
}
