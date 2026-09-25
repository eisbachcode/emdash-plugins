/**
 * Settings value coercion. Shared because every plugin here stores its
 * configuration in plugin KV, and KV hands back `unknown`.
 */

/**
 * Parse the comma-separated collection list.
 *
 * The list is configuration rather than something discovered at runtime
 * because a plugin **cannot enumerate collections**: the content API
 * takes a collection name on every call and nothing on `PluginContext`
 * lists them.
 */
export function parseCollections(raw: unknown): string[] {
	if (typeof raw !== "string") return [];
	return [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
}

/**
 * Coerce a stored number into range, or fall back.
 *
 * Absent means absent: `ctx.kv.get` answers `null` for an unset key, and
 * `Number(null)` is 0 — which would silently clamp to `min` instead of
 * using the default. Booleans coerce just as happily, so the accepted
 * input types are named rather than inferred.
 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" && typeof value !== "string") return fallback;
	if (typeof value === "string" && !value.trim()) return fallback;
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}
