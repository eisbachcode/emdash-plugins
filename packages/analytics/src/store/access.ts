/**
 * Typed access to the declared storage collections.
 *
 * `PluginContext["storage"]` maps every declared collection to
 * `StorageCollection<unknown>`, and its methods are not generic, so the
 * document type has to be asserted somewhere. Doing it once here keeps
 * the assertion in a single reviewable place instead of scattering `as`
 * through the sync job, and gives the rest of the plugin an honest typed
 * surface.
 *
 * Each collection is also optional at runtime: a plugin whose manifest
 * declares no storage gets nothing, and an operator running an older
 * manifest may be missing one. Callers get `null` and decide, rather than
 * a `TypeError` inside a cron tick that has no retry.
 */

import type { PluginContext } from "emdash/plugin";

import type { DailyRow, EntryRow, RollupRow } from "./rows.js";

export interface Page<T> {
	items: Array<{ id: string; data: T }>;
	cursor?: string;
	hasMore: boolean;
}

export interface QuerySpec {
	where?: Record<string, unknown>;
	orderBy?: Record<string, "asc" | "desc">;
	limit?: number;
	cursor?: string;
}

export interface Typed<T> {
	get(id: string): Promise<T | undefined>;
	getMany(ids: string[]): Promise<Map<string, T>>;
	put(id: string, data: T): Promise<void>;
	putMany(items: Array<{ id: string; data: T }>): Promise<void>;
	deleteMany(ids: string[]): Promise<number>;
	query(spec?: QuerySpec): Promise<Page<T>>;
}

/** Storage clamps a query's `limit` to 100 rows. */
export const BIND_LIMIT = 100;

/**
 * Most ids one `getMany` or `deleteMany` may carry.
 *
 * D1 binds at most 100 parameters per statement, and storage builds one
 * unchunked `IN (...)` that also binds the plugin id and the collection
 * name. So 98, not 100: a full page from `query()` is two ids too many.
 * The wrapper below splits every call, so callers cannot get this wrong.
 */
export const ID_BATCH = BIND_LIMIT - 2;

export function chunk<T>(items: T[], size: number = ID_BATCH): T[][] {
	if (size < 1) return items.length > 0 ? [items] : [];
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

function wrap<T>(raw: unknown): Typed<T> | null {
	if (!raw || typeof raw !== "object") return null;
	const col = raw as {
		get(id: string): Promise<unknown>;
		getMany(ids: string[]): Promise<Map<string, unknown>>;
		put(id: string, data: unknown): Promise<void>;
		putMany(items: Array<{ id: string; data: unknown }>): Promise<void>;
		deleteMany(ids: string[]): Promise<number>;
		query(spec?: unknown): Promise<{ items: Array<{ id: string; data: unknown }>; cursor?: string; hasMore: boolean }>;
	};

	return {
		async get(id) {
			const value = await col.get(id);
			return (value ?? undefined) as T | undefined;
		},
		async getMany(ids) {
			const out = new Map<string, T>();
			for (const slice of chunk(ids)) {
				for (const [id, value] of await col.getMany(slice)) out.set(id, value as T);
			}
			return out;
		},
		put(id, data) {
			return col.put(id, data);
		},
		putMany(items) {
			return col.putMany(items);
		},
		async deleteMany(ids) {
			let deleted = 0;
			for (const slice of chunk(ids)) deleted += await col.deleteMany(slice);
			return deleted;
		},
		async query(spec) {
			const page = await col.query(spec);
			return page as Page<T>;
		},
	};
}

export function dailyStore(ctx: PluginContext): Typed<DailyRow> | null {
	return wrap<DailyRow>(ctx.storage?.daily);
}

export function rollupStore(ctx: PluginContext): Typed<RollupRow> | null {
	return wrap<RollupRow>(ctx.storage?.rollup);
}

export function entriesStore(ctx: PluginContext): Typed<EntryRow> | null {
	return wrap<EntryRow>(ctx.storage?.entries);
}
