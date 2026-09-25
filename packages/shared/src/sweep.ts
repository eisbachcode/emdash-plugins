/**
 * Cursor-driven collection walk.
 *
 * Both plugins sweep every collection page by page across cron
 * ticks rather than in one pass, for the same reason: a sandboxed plugin
 * gets 10 subrequests per invocation on Cloudflare and the limit counts
 * service-binding calls, so `ctx.content`, `ctx.storage` and `ctx.kv`
 * spend from the same budget as an outbound fetch. The limits are fixed —
 * the emdash integration exposes no option for them.
 *
 * The cursor lives in plugin KV, so a tick that dies loses at most its
 * own page.
 */

import type { PluginContext } from "emdash/plugin";

/**
 * The entry type `ctx.content.list()` hands back.
 *
 * Derived rather than imported: `emdash/plugin` does not export it, and
 * the identically-named `ContentItem` on the package root is the
 * *database row* type (`authorId`, `liveRevisionId`, …), which does not
 * match. Deriving from the context is exact by construction and cannot
 * drift from the runtime shape.
 */
export type PluginContentItem = Awaited<
	ReturnType<NonNullable<PluginContext["content"]>["list"]>
>["items"][number];

export interface CollectionPage {
	collection: string;
	items: PluginContentItem[];
	/** True when this was the last page of that collection. */
	lastPage: boolean;
}

/** A collection as `schema:read` describes it. Derived for the same reason as `PluginContentItem`. */
export type PluginCollectionInfo = Awaited<
	ReturnType<NonNullable<PluginContext["schema"]>["listCollections"]>
>[number];

/** Every collection on the site, or none when `schema:read` was not granted. */
export async function listCollections(ctx: PluginContext): Promise<PluginCollectionInfo[]> {
	return ctx.schema ? ctx.schema.listCollections() : [];
}

/** Marker written to the cursor key once a collection is fully walked. */
const DONE = "done";

/**
 * Fetch the next unfinished page across `collections`, in order.
 * Returns `null` when every collection is walked — the caller's signal
 * that a sweep is complete and the cursors can be reset.
 */
export async function nextCollectionPage(
	ctx: PluginContext,
	collections: string[],
	cursorPrefix: string,
	pageSize: number,
): Promise<CollectionPage | null> {
	if (!ctx.content) return null;

	for (const collection of collections) {
		const cursorKey = `${cursorPrefix}${collection}`;
		const cursor = await ctx.kv.get<string>(cursorKey);
		if (cursor === DONE) continue;

		const page = await ctx.content.list(collection, {
			limit: pageSize,
			...(cursor ? { cursor } : {}),
		});

		await ctx.kv.set(cursorKey, page.cursor ?? DONE);
		return { collection, items: page.items, lastPage: !page.cursor };
	}

	return null;
}

/** Clear every cursor so the next tick starts a fresh sweep. */
export async function resetCursors(
	ctx: PluginContext,
	collections: string[],
	cursorPrefix: string,
): Promise<void> {
	for (const collection of collections) {
		await ctx.kv.delete(`${cursorPrefix}${collection}`);
	}
}
