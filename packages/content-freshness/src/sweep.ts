/**
 * The audit: a sweep over every collection, one page per cron run.
 *
 * A sandboxed plugin gets ten subrequests per invocation and every `ctx`
 * call is one, so a run does one bounded slice and hands over to a
 * follow-up. An audit run costs two KV reads (settings, state), one
 * `content.list`, one `dismissals.getMany`, at most one `putMany` and one
 * `deleteMany`, one KV write and one schedule, plus the collection list when
 * a sweep starts: nine at most. A cleanup run costs six, its log line
 * included. `tests/budget.test.ts` counts every path; run it after adding a
 * `ctx` call.
 *
 * When the last collection is done, the sweep removes every row it did not
 * write or confirm: entries that were trashed or deleted, and collections
 * that are gone.
 */

import { isFollowUp, listCollections, scheduleFollowUp, type ChainEvent, type SweepChain } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext } from "emdash/plugin";

import type { EntryDismissals } from "./dismissals.js";
import { evaluateEntries, store } from "./findings.js";
import { findingId, ID_BATCH } from "./ids.js";
import { datetimeFields } from "./rules.js";
import { contextFor, readSettings, thresholdsFor, type Settings } from "./settings.js";
import { AUDIT_TASK } from "./schedule.js";
import { readState, SWEEP_VERSION, writeState, type CollectionInfo, type State, type Sweep } from "./state.js";

/** The one-shot the "Audit now" button schedules. See `plugin.ts` for why it has its own name. */
export const AUDIT_NOW_TASK = "audit-now";

/** 500 runs is 50,000 entries at the largest page size. */
export const CHAIN: SweepChain = { next: ["audit-next-a", "audit-next-b"], maxSteps: 500 };

/** A sweep that has not finished in this long is dropped and started over. */
const ABANDON_AFTER_MS = 7 * 24 * 60 * 60 * 1000;


/**
 * Handle a cron event. A start while a sweep is under way continues that
 * sweep instead of resetting it, so a site whose sweep outlasts a day
 * still finishes, and a follow-up chain that got lost resumes on the next
 * scheduled run.
 */
export async function runAudit(ctx: PluginContext, event: ChainEvent): Promise<void> {
	const starts = event.name === AUDIT_TASK || event.name === AUDIT_NOW_TASK;
	if (!starts && !isFollowUp(CHAIN, event.name)) return;
	// Without `schema:read` the collection list comes back empty, and a sweep
	// over no collections would go straight to cleaning up every row.
	if (!ctx.content || !ctx.schema) return;

	const [settings, state] = await Promise.all([readSettings(ctx), readState(ctx)]);
	const now = new Date();

	if (state.sweep && state.sweep.version !== SWEEP_VERSION) {
		// Written by an earlier version of the plugin: start over, whatever
		// the event, rather than audit with information the sweep lacks.
		state.sweep = await newSweep(ctx, settings, now);
	} else if (!state.sweep || abandoned(state.sweep, now)) {
		// A follow-up of a sweep that already finished has nothing to do.
		if (!starts) return;
		state.sweep = await newSweep(ctx, settings, now);
	}

	const more = await step(ctx, settings, state, now);
	await writeState(ctx, state);
	if (more && !(await scheduleFollowUp(ctx, CHAIN, event))) {
		ctx.log.warn(`Audit paused after ${CHAIN.maxSteps} runs; it continues at the next scheduled run`);
	}
}

/**
 * A sweep over every collection not left out. With none left it still runs
 * its cleanup, which removes the rows of collections that were left out.
 */
async function newSweep(ctx: PluginContext, settings: Settings, now: Date): Promise<Sweep> {
	const audited = (await listCollections(ctx)).filter((collection) => !thresholdsFor(settings, collection.slug).skip);
	const info: Record<string, CollectionInfo> = {};
	for (const collection of audited) {
		info[collection.slug] = {
			dateFields: datetimeFields(collection.fields),
			revisions: collection.supports.includes("revisions"),
		};
	}
	return {
		version: SWEEP_VERSION,
		startedAt: now.toISOString(),
		collections: audited.map((collection) => collection.slug),
		index: 0,
		cursor: null,
		phase: "audit",
		info,
	};
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
		limit: ID_BATCH,
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
	const thresholds = thresholdsFor(settings, collection);
	// Left out since the sweep started: its rows go with the cleanup.
	if (thresholds.skip) {
		sweep.index += 1;
		sweep.cursor = null;
		return;
	}
	let page;
	try {
		page = await content.list(collection, {
			limit: settings.pageSize,
			...(sweep.cursor ? { cursor: sweep.cursor } : {}),
		});
	} catch (error) {
		// Only a collection deleted since the sweep started is skipped; its
		// rows then fail the cleanup's `seenIn` check with the other
		// leftovers. Any other failure propagates before the state is
		// written, so no finding is removed for a collection that was never
		// audited, and the next scheduled run retries this page.
		if (await collectionExists(ctx, collection)) throw error;
		ctx.log.warn(`Skipping collection ${collection}, which no longer exists`);
		sweep.index += 1;
		sweep.cursor = null;
		return;
	}

	const ids = page.items.map((entry) => findingId(collection, entry.id));
	const dismissals = ids.length > 0 ? await ctx.storage.dismissals.getMany(ids) : new Map();
	await store(
		ctx,
		evaluateEntries(
			collection,
			page.items,
			thresholds,
			now,
			sweep.startedAt,
			dismissals as Map<string, EntryDismissals>,
			contextFor(settings, collection, sweep.info[collection]),
		),
	);

	if (page.cursor) {
		sweep.cursor = page.cursor;
	} else {
		sweep.index += 1;
		sweep.cursor = null;
	}
}

async function collectionExists(ctx: PluginContext, slug: string): Promise<boolean> {
	if (!ctx.schema) return true;
	return (await ctx.schema.getCollection(slug)) !== null;
}
