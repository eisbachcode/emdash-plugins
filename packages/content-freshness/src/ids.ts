/**
 * Storage keys and the size of one storage call.
 */

/**
 * Most ids one storage call may carry.
 *
 * In-process, `getMany` and `deleteMany` build one `IN (...)` that also binds
 * the plugin id and the collection name, and D1 binds at most 100 parameters
 * per statement. The sandbox bridge does the same for `getMany`. Every call
 * that takes a page of ids therefore stays at 98, which is why a run audits
 * at most 98 entries and a cleanup run removes at most 98 rows.
 */
export const ID_BATCH = 98;

/** The key of an entry's finding row and of its dismissals document. */
export function findingId(collection: string, entryId: string): string {
	return `${collection}:${entryId}`;
}
