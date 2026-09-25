/**
 * The path -> entry index: the join that makes this plugin different from
 * every other analytics plugin in the catalogue.
 *
 * **Built forward, never parsed backwards.** Turning a provider's
 * `requestPath` back into an entry would mean reimplementing core's URL
 * patterns, and core's own `resolveEmDashPath()` is not on `ctx`, is
 * anchored so `/blog/foo/` fails, and does not strip locale prefixes.
 * Instead every save and publish asks `getPublicUrl()` where the entry
 * actually lives and stores that. The result is exact by construction,
 * costs nothing at lookup time, and rolls translations up for free
 * because `getTranslations()` hands back the group.
 *
 * Rows for unpublished and deleted entries are kept, marked rather than
 * removed, so history stays attributable; `reconcile` prunes them once
 * their traffic has aged out of retention.
 */

import type { PluginContext } from "emdash/plugin";

import { entriesStore, BIND_LIMIT } from "../store/access.js";
import type { EntryRow } from "../store/rows.js";
import { normalizePath } from "./paths.js";

export interface EntryRef {
	collection: string;
	id: string;
}

/**
 * Pull `{ collection, id }` out of whichever content event fired.
 *
 * The five content hooks do not share one event shape:
 * `content:afterDelete` carries `{ id, collection }` while the others
 * carry `{ content, collection }` with the id inside `content`. Reading
 * both shapes here keeps that difference in one place instead of in five
 * handlers.
 */
export function entryRefOf(event: unknown): EntryRef | null {
	if (typeof event !== "object" || event === null) return null;
	const e = event as Record<string, unknown>;
	const collection = typeof e.collection === "string" ? e.collection : null;
	if (!collection) return null;

	const direct = typeof e.id === "string" ? e.id : null;
	const content = typeof e.content === "object" && e.content !== null ? (e.content as Record<string, unknown>) : null;
	const nested = content && typeof content.id === "string" ? content.id : null;

	const id = direct ?? nested;
	return id ? { collection, id } : null;
}

export type EntryStatus = EntryRow["status"];

/**
 * Record where an entry is published, or mark that it no longer is.
 *
 * Returns the path it indexed, or `null` when the entry has no public URL
 * — unpublished, non-routable, no slug, no configured site URL. That is a
 * normal answer, not an error: plenty of entries are legitimately not on
 * the web, and guessing a URL for them would poison the join.
 */
export async function indexEntry(
	ctx: PluginContext,
	ref: EntryRef,
	status: EntryStatus,
	now: Date,
	/**
	 * The entry's fields as the hook already delivered them. Passing them in
	 * saves a `ctx.content.get()` round trip per save — the hook is holding
	 * the record, so asking the host for it again costs a bridge call from a
	 * ten-call budget to learn something already known.
	 */
	fields?: Record<string, unknown>,
): Promise<string | null> {
	if (!ctx.content?.getPublicUrl) {
		ctx.log.warn("analytics: content:read is declared but getPublicUrl is unavailable");
		return null;
	}

	// Called through the context rather than extracted and re-bound: the
	// sandbox exposes these as proxied methods, and `fn.call(ctx.content, …)`
	// does not survive that indirection.
	const url = await ctx.content.getPublicUrl(ref.collection, ref.id);
	if (!url) return null;

	const path = normalizePath(url, ctx.site.trailingSlash);

	const [translationGroup, locale] = await readTranslation(ctx, ref);
	const title = await readTitle(ctx, ref, fields);

	// The entry's rows by id rather than the one row by path: after a slug
	// change the row at the old path is still marked published, and the
	// per-entry page would list the entry twice.
	const entries = entriesStore(ctx);
	const mine = entries ? (await entries.query({ where: { entryId: ref.id }, limit: BIND_LIMIT })).items : [];

	// Preserve the accumulated numbers: this hook knows about the entry,
	// not about its traffic, and overwriting the view counts with zeroes
	// here would blank the content page on every save. They belong to the
	// path, so a path another entry used before keeps its numbers too.
	const existing = mine.find((item) => item.id === path)?.data ?? (await entries?.get(path));
	const publishedAt = publishedAtOf(fields) ?? existing?.publishedAt;

	const row: EntryRow = {
		path,
		collection: ref.collection,
		entryId: ref.id,
		translationGroup: translationGroup ?? ref.id,
		locale: locale ?? ctx.site.locale,
		title,
		status,
		...(publishedAt && { publishedAt }),
		views7: existing?.views7 ?? 0,
		views30: existing?.views30 ?? 0,
		...(existing?.recentViews !== undefined && { recentViews: existing.recentViews }),
		...(existing?.olderViews !== undefined && { olderViews: existing.olderViews }),
		...(existing?.olderDay !== undefined && { olderDay: existing.olderDay }),
		updatedAt: now.toISOString(),
	};

	const moved = mine
		.filter((item) => item.id !== path && item.data.status === "published")
		.map((item) => ({ id: item.id, data: { ...item.data, status: "moved" as const, updatedAt: now.toISOString() } }));
	await entries?.putMany([{ id: path, data: row }, ...moved]);
	return path;
}

/**
 * Mark an entry's row without needing its public URL.
 *
 * On unpublish and delete `getPublicUrl()` returns `null` — the entry is
 * no longer routable — so the path has to be found by the entry id
 * instead. `entryId` is a declared index, which is what makes that query
 * legal.
 */
export async function markEntryStatus(
	ctx: PluginContext,
	ref: EntryRef,
	status: EntryStatus,
	now: Date,
): Promise<number> {
	const collection = entriesStore(ctx);
	if (!collection) return 0;

	const page = await collection.query({ where: { entryId: ref.id }, limit: 100 });
	if (page.items.length === 0) return 0;

	const updates = page.items.map(({ id, data }) => ({
		id,
		data: { ...data, status, updatedAt: now.toISOString() },
	}));
	await collection.putMany(updates);
	return updates.length;
}

async function readTranslation(ctx: PluginContext, ref: EntryRef): Promise<[string | null, string | null]> {
	if (!ctx.content?.getTranslations) return [null, null];
	try {
		const result = await ctx.content.getTranslations(ref.collection, ref.id);
		const mine = result.translations.find((t) => t.id === ref.id);
		return [result.translationGroup, mine?.locale ?? null];
	} catch {
		// A missing translation group is not worth failing a save over.
		return [null, null];
	}
}

/**
 * The entry's display title.
 *
 * Read through the collection's declared `titleField` rather than by
 * assuming the field is called "title" — but only out of the record the
 * hook already carried. If the collection declares a title field that is
 * not present, or nothing was carried, the widget falls back to showing
 * the path, which is a worse label but never a wrong one.
 */
async function readTitle(ctx: PluginContext, ref: EntryRef, fields?: Record<string, unknown>): Promise<string> {
	if (!fields) return "";

	let titleField: string | null = null;
	try {
		titleField = (await ctx.schema?.getCollection(ref.collection))?.titleField ?? null;
	} catch {
		// Schema lookup is a convenience here, not a requirement.
	}

	const nested = typeof fields.data === "object" && fields.data !== null ? (fields.data as Record<string, unknown>) : null;
	const candidates = [titleField, "title", "name", "heading"].filter((k): k is string => Boolean(k));

	for (const key of candidates) {
		for (const source of [fields, nested]) {
			const value = source?.[key];
			if (typeof value === "string" && value) return value;
		}
	}
	return "";
}

function publishedAtOf(fields: Record<string, unknown> | undefined): string | undefined {
	const value = fields?.publishedAt ?? fields?.published_at;
	return typeof value === "string" && value ? value : undefined;
}
