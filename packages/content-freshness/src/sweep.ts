/**
 * The audit: a sweep over every collection, one page per cron run.
 *
 * A sandboxed plugin gets ten subrequests per invocation and every `ctx`
 * call is one, so a run does one bounded slice and hands over to a
 * follow-up. A run costs two KV reads, one `content.list`, at most one
 * `putMany` and one `deleteMany`, one KV write and one schedule, plus the
 * collection list when a sweep starts.
 *
 * When the last collection is done, the sweep removes every row it did not
 * write or confirm: entries that were trashed or deleted, and collections
 * that are gone.
 */

import { isFollowUp, listCollections, scheduleFollowUp, type ChainEvent, type SweepChain } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext } from "emdash/plugin";

import { evaluateEntries, store } from "./findings.js";
import { readSettings, type Settings } from "./settings.js";
import { AUDIT_TASK, readState, writeState, type State, type Sweep } from "./state.js";

/** The one-shot the "Audit now" button schedules. See `plugin.ts` for why it has its own name. */
export const AUDIT_NOW_TASK = "audit-now";

/** 500 runs is 50,000 entries at the largest page size. */
export const CHAIN: SweepChain = { next: ["audit-next-a", "audit-next-b"], maxSteps: 500 };

/** A sweep that has not finished in this long is dropped and started over. */
const ABANDON_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Most stale rows one cleanup run removes: storage queries return at most 100. */
const CLEANUP_BATCH = 100;

/**
 * Handle a cron event. A start while a sweep is under way continues that
 * sweep instead of resetting it, so a site whose sweep outlasts a day
 * still finishes, and a follow-up chain that got lost resumes on the next
 * scheduled run.
 */
export async function runAudit(ctx: PluginContext, event: ChainEvent): Promise<void> {
	const starts = event.name === AUDIT_TASK || event.name === AUDIT_NOW_TASK;
	if (!starts && !isFollowUp(CHAIN, event.name)) return;
	if (!ctx.content) return;

	const [settings, state] = await Promise.all([readSettings(ctx), readState(ctx)]);
	const now = new Date();

	if (!state.sweep || abandoned(state.sweep, now)) {
		// A follow-up of a sweep that already finished has nothing to do.
		if (!starts) return;
		state.sweep = await newSweep(ctx, now);
		if (!state.sweep) return;
	}

	const more = await step(ctx, settings, state, now);
	await writeState(ctx, state);
	if (more && !(await scheduleFollowUp(ctx, CHAIN, event))) {
		ctx.log.warn(`Audit paused after ${CHAIN.maxSteps} runs; it continues at the next scheduled run`);
	}
}

async function newSweep(ctx: PluginContext, now: Date): Promise<Sweep | null> {
	const collections = (await listCollections(ctx)).map((collection) => collection.slug);
	if (collections.length === 0) return null;
	return { startedAt: now.toISOString(), collections, index: 0, cursor: null, phase: "audit" };
}

function abandoned(sweep: Sweep, now: Date): boolean {
	return now.getTime() - Date.parse(sweep.startedAt) > ABANDON_AFTER_MS;
}

/** One slice of work. Returns whether the sweep needs another run. */
async function step(ctx: PluginContext, settings: Settings, state: State, now: Date): Promise<boolean> {
	const sweep = state.sweep;
	if (!sweep) return false;

	if (sweep.phase === "audit") {
		const collection = sweep.collections[sweep.index];
		if (collection !== undefined) {
			await auditPage(ctx, settings, sweep, collection, now);
			return true;
		}
		sweep.phase = "cleanup";
	}

	const stale = await ctx.storage.findings.query({
		where: { seenIn: { lt: sweep.startedAt } },
		limit: CLEANUP_BATCH,
	});
	if (stale.items.length > 0) await ctx.storage.findings.deleteMany(stale.items.map((item) => item.id));
	if (stale.hasMore) return true;

	state.sweep = null;
	state.lastFinishedAt = now.toISOString();
	ctx.log.info("Freshness audit complete");
	return false;
}

async function auditPage(
	ctx: PluginContext,
	settings: Settings,
	sweep: Sweep,
	collection: string,
	now: Date,
): Promise<void> {
	const content = ctx.content;
	if (!content) return;
	let page;
	try {
		page = await content.list(collection, {
			limit: settings.pageSize,
			...(sweep.cursor ? { cursor: sweep.cursor } : {}),
		});
	} catch (error) {
		// A collection deleted since the sweep started. Its rows fail the
		// cleanup's `seenIn` check and go with the other leftovers.
		ctx.log.warn(`Skipping collection ${collection}: ${String(error)}`);
		sweep.index += 1;
		sweep.cursor = null;
		return;
	}

	await store(ctx, evaluateEntries(collection, page.items, settings, now, sweep.startedAt));

	if (page.cursor) {
		sweep.cursor = page.cursor;
	} else {
		sweep.index += 1;
		sweep.cursor = null;
	}
}
