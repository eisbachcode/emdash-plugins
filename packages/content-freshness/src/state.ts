/**
 * Where the audit stands, under one KV key: one read and at most one write
 * per run, however many collections the site has. Only cron runs write it.
 */

import type { PluginContext } from "emdash/plugin";

export const STATE_KEY = "state";

/** Raised whenever `Sweep` changes shape; a sweep of an older shape starts over. */
export const SWEEP_VERSION = 2;

/** What a sweep reads about a collection when it starts. */
export interface CollectionInfo {
	/** Its `datetime` fields, for the expiry rule. */
	dateFields: Array<{ slug: string; label: string }>;
	/** Whether it keeps revisions, for the unpublished-changes rule. */
	revisions: boolean;
}

export interface Sweep {
	version: number;
	/** Rows written by this sweep carry this as `seenIn`; older ones are removed at the end. */
	startedAt: string;
	/** The collections as they were when the sweep started, walked in order. */
	collections: string[];
	index: number;
	/** `content.list` cursor within `collections[index]`. */
	cursor: string | null;
	phase: "audit" | "cleanup";
	/** Per collection, read with the collection list so a page needs no schema call. */
	info: Record<string, CollectionInfo>;
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
