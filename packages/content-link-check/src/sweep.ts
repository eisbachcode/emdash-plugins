/**
 * The sweep, one bounded step at a time.
 *
 * Every invocation draws from one `Budget` of bridge calls, D1 queries and
 * outbound subrequests (see `budget.ts`), so each phase batches its storage
 * work and stops when the budget would not cover its next step:
 *
 *   1. **walk** — read a page of published entries and write one row per
 *      target they link to, stamped with the sweep's start and carrying the
 *      places it is linked from. A target not seen before is stored as
 *      pending.
 *   2. **prune** — delete the targets this sweep did not stamp: links taken
 *      out, entries unpublished or deleted.
 *   3. **check** — request the targets not checked since the sweep began,
 *      as many as the budget allows, and store the verdicts.
 *
 * The phase, collection, cursor and host backoff live in one KV object.
 * Every step can be repeated: a run that dies before saving the state is
 * followed by one that redoes its step without counting anything twice.
 */

import { listCollections } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext } from "emdash/plugin";

import { QUERIES, type Budget } from "./budget.js";
import { checkUrl, judge, worstOutbound, type LinkHistory } from "./check.js";
import { classify, extractLinks, toRequestUrl, type LinkScope } from "./extract.js";
import type { Settings } from "./settings.js";
import { beginSweep, loadAll, REQUEST_KEY, STATE_KEY, type SweepState } from "./state.js";
import { findingFor, MAX_IDS, PLACES_KEPT, pendingCheck, type CheckRow, type Place } from "./store.js";

/** HEAD, and the GET a failed HEAD may earn. */
const CALLS_PER_LINK = 2;
/** A page linking to more targets than this is read in fewer entries. */
const PAGE_TARGETS = 20;
/** Targets of one entry that are recorded; an entry linking to more is cut short. */
const ENTRY_TARGETS = 2 * MAX_IDS;

/**
 * One run of the sweep. `start` is a scheduled start: it begins a new sweep
 * if none is under way, and otherwise lets the current one carry on. A
 * requested sweep begins at whichever run comes next. Returns whether there
 * is more to do.
 */
export async function sweepTick(ctx: PluginContext, budget: Budget, options: { start: boolean }): Promise<boolean> {
	const { settings, state: loaded, requestedAt } = await loadAll(ctx);
	budget.spend();

	const requested = requestedAt !== null && requestedAt > (loaded.startedAt ?? "");
	let state = (options.start && loaded.phase === "done") || requested ? { ...loaded, phase: "begin" as const } : loaded;
	if (state.phase === "done") return false;
	if (state.phase === "begin") {
		const collections = (await listCollections(ctx)).map((collection) => collection.slug);
		budget.spend(1, QUERIES.listCollections);
		state = beginSweep(state, collections, new Date());
	}

	// The state write and the follow-up that end every run that did work.
	budget.spend(2, 1 + QUERIES.cronSchedule);

	while (state.phase === "walk") {
		const step = await walk(ctx, budget, settings, state);
		state = step.state;
		if (!step.progressed) break;
	}
	while (state.phase === "prune" && budget.left >= 2 && budget.queriesLeft >= 2) state = await prune(ctx, budget, state);
	if (state.phase === "check" && budget.left >= 2 + CALLS_PER_LINK && budget.queriesLeft >= 3) {
		state = await check(ctx, budget, settings, state);
	}

	await ctx.kv.set(STATE_KEY, state);
	return state.phase !== "done";
}

/** Asks the next run to begin a fresh sweep. */
export async function requestSweep(ctx: PluginContext): Promise<void> {
	await ctx.kv.set(REQUEST_KEY, new Date().toISOString());
}

interface Linked {
	scope: LinkScope;
	places: Place[];
	count: number;
}

async function walk(
	ctx: PluginContext,
	budget: Budget,
	settings: Settings,
	state: SweepState,
): Promise<{ state: SweepState; progressed: boolean }> {
	const collection = state.collections[state.collectionIndex];
	if (collection === undefined || !ctx.content || !state.startedAt) {
		return { state: { ...state, phase: "prune", cursor: null }, progressed: true };
	}
	// A page, one lookup and one write, at the least.
	if (budget.left < 3 || budget.queriesLeft < QUERIES.contentPage + 2) return { state, progressed: false };
	const seenAt = state.startedAt;
	const pageSize = state.pageSize ?? settings.batchSize;
	const pageKey = `${collection}:${state.cursor ?? ""}:${pageSize}`;

	const page = await ctx.content.list(collection, {
		limit: pageSize,
		where: { status: "published" },
		...(state.cursor ? { cursor: state.cursor } : {}),
	});
	budget.spend(1, QUERIES.contentPage);

	const linked = linksIn(page.items, collection, ctx.site.url, settings);
	const targets = [...linked.keys()];
	if (targets.length > PAGE_TARGETS && page.items.length > 1) {
		const smaller = Math.max(1, Math.floor((page.items.length * PAGE_TARGETS) / targets.length));
		return { state: { ...state, pageSize: smaller }, progressed: true };
	}

	const lookups = chunk(targets.slice(0, ENTRY_TARGETS), MAX_IDS);
	if (budget.left < lookups.length + 1 || budget.queriesLeft < lookups.length + 1) return { state, progressed: false };
	const known = new Map<string, CheckRow>();
	for (const ids of lookups) {
		for (const [id, row] of await ctx.storage.checks.getMany(ids)) known.set(id, row as CheckRow);
		budget.spend();
	}

	const writes = lookups.flat().flatMap((target) => {
		const row = stamped(known.get(target), target, linked.get(target)!, seenAt, pageKey);
		return row ? [{ id: target, data: row }] : [];
	});
	const now = writes.slice(0, budget.queriesLeft);
	if (now.length > 0) {
		await ctx.storage.checks.putMany(now);
		budget.spend(1, now.length);
	}
	// What did not fit is written when the page is read again; what was
	// written is then recognised by its page key and skipped.
	if (now.length < writes.length) return { state, progressed: false };

	const grown = Math.min(settings.batchSize, pageSize * 2);
	const next = { ...state, pageSize: grown >= settings.batchSize ? null : grown };
	return {
		state: page.cursor
			? { ...next, cursor: page.cursor }
			: { ...next, collectionIndex: state.collectionIndex + 1, cursor: null },
		progressed: true,
	};
}

/** Every target the entries link to, with where, in the order found. */
function linksIn(
	entries: Array<{ id: string; slug?: string | null; locale?: string | null; data: unknown; seo?: unknown }>,
	collection: string,
	siteUrl: string,
	settings: Settings,
): Map<string, Linked> {
	const linked = new Map<string, Linked>();
	for (const entry of entries) {
		for (const link of extractLinks({ ...(entry.data as object), seo: entry.seo })) {
			const scope = classify(link.url, siteUrl);
			if (scope === "external" && !settings.checkExternal) continue;
			const requestUrl = toRequestUrl(link.url, siteUrl);
			const target = requestUrl ? withoutFragment(requestUrl) : link.url;
			const seen = linked.get(target) ?? { scope, places: [], count: 0 };
			seen.count++;
			if (seen.places.length < PLACES_KEPT) {
				seen.places.push({
					url: link.url,
					path: link.path,
					collection,
					entryId: entry.id,
					entrySlug: entry.slug ?? null,
					locale: entry.locale ?? null,
				});
			}
			linked.set(target, seen);
		}
	}
	return linked;
}

/**
 * A target's row with this sweep's stamp, or null when this page already
 * stamped it. The places start over with each sweep, so an entry that
 * stopped linking drops out of them.
 */
function stamped(
	known: CheckRow | undefined,
	target: string,
	found: Linked,
	seenAt: string,
	pageKey: string,
): CheckRow | null {
	if (!known) return { ...pendingCheck(target, found.scope, seenAt, found.places, found.count), lastPage: pageKey };
	const sameSweep = known.seenAt === seenAt;
	if (sameSweep && known.lastPage === pageKey) return null;
	return {
		...known,
		seenAt,
		lastPage: pageKey,
		places: [...(sameSweep ? (known.places ?? []) : []), ...found.places].slice(0, PLACES_KEPT),
		placeCount: (sameSweep ? (known.placeCount ?? 0) : 0) + found.count,
	};
}

async function prune(ctx: PluginContext, budget: Budget, state: SweepState): Promise<SweepState> {
	const stale = await ctx.storage.checks.query({
		where: { seenAt: { lt: state.startedAt ?? "" } },
		limit: MAX_IDS,
	});
	budget.spend();
	if (stale.items.length === 0) return { ...state, phase: "check" };

	await ctx.storage.checks.deleteMany(stale.items.map((item) => item.id));
	budget.spend();
	return state;
}

async function check(ctx: PluginContext, budget: Budget, settings: Settings, state: SweepState): Promise<SweepState> {
	const due = await ctx.storage.checks.query({
		where: { checkedAt: { lt: state.startedAt ?? "" } },
		limit: Math.max(1, Math.min(MAX_IDS, budget.queriesLeft - 2, budget.left)),
	});
	budget.spend();
	if (due.items.length === 0) return { ...state, phase: "done", finishedAt: new Date().toISOString() };

	// The `putMany` below; its rows are charged once they are known.
	budget.spend(1, 0);
	const backoff = { ...state.backoff };
	const updates: Array<{ id: string; data: CheckRow }> = [];
	for (const { id, data } of due.items) {
		if (budget.queriesLeft - updates.length < 1) break;
		const row = data as CheckRow;
		const now = new Date();
		const host = hostOf(row.target);
		const backoffUntil = host ? backoff[host] : undefined;
		if (backoffUntil && Date.parse(backoffUntil) > now.getTime()) {
			// Counted as checked for this sweep, so a host that keeps a whole
			// batch waiting cannot stall the targets behind it.
			updates.push({ id, data: { ...row, checkedAt: now.toISOString() } });
			continue;
		}
		const options = { outbound: row.scope === "external" };
		if (budget.left < CALLS_PER_LINK || budget.outboundLeft < worstOutbound(options)) break;

		const result = await checkUrl(ctx, row.target, options);
		budget.spend(result.requests, 0);
		budget.spendOutbound(result.outbound);
		if (host && result.retryAfter) backoff[host] = result.retryAfter;

		const previous = row.state === "pending" ? null : (row as LinkHistory);
		const verdict = judge(previous, result, now, settings.failureThreshold);
		updates.push({
			id,
			data:
				!verdict.conclusive && previous
					? { ...row, checkedAt: now.toISOString() }
					: {
							...row,
							state: verdict.state,
							reason: result.reason,
							status: result.status,
							location: result.location,
							finalUrl: result.finalUrl,
							error: result.error,
							consecutiveFailures: verdict.consecutiveFailures,
							firstFailedAt: verdict.firstFailedAt,
							reported: verdict.reported,
							finding: findingFor(verdict),
							checkedAt: now.toISOString(),
						},
		});
	}

	if (updates.length > 0) {
		await ctx.storage.checks.putMany(updates);
		budget.spend(0, updates.length);
	}
	return { ...state, backoff: current(backoff) };
}

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

function withoutFragment(url: string): string {
	const parsed = new URL(url);
	parsed.hash = "";
	return parsed.href;
}

function hostOf(target: string): string {
	try {
		return new URL(target).host;
	} catch {
		return "";
	}
}

function current(backoff: Record<string, string>): Record<string, string> {
	const now = Date.now();
	return Object.fromEntries(Object.entries(backoff).filter(([, until]) => Date.parse(until) > now));
}
