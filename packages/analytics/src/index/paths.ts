/**
 * Path normalization. Pure.
 *
 * Two sides have to agree on what a path is: what Cloudflare reports as
 * `requestPath`, and what `ctx.content.getPublicUrl()` says the entry
 * lives at. When they disagree the join silently produces nothing, which
 * is the worst possible failure — the dashboard looks fine and every
 * entry reads zero.
 *
 * This is not hypothetical. The first live pull from a production site on
 * 2026-09-20 returned `/datenschutz` and `/datenschutz/` as two separate
 * rows, each with its own view count, for one page.
 *
 * What this deliberately does NOT do:
 *
 * - **Lower-case.** Paths are case-sensitive by specification, and folding
 *   them would merge URLs that a site may legitimately serve differently.
 *   Hosts differ; paths do not.
 * - **Strip locale prefixes.** The index is built forward from
 *   `getPublicUrl()`, so an entry's stored path already carries whatever
 *   prefix the site serves, and the provider reports the same prefix.
 *   Both sides match without help. Rolling translations together is the
 *   job of `translationGroup`, not of guessing which leading segment is a
 *   language code — `/de/` is a locale on one site and a page on another.
 */

/** Astro's routing policy, as `SiteInfo.trailingSlash` reports it. */
export type TrailingSlash = "always" | "never" | "ignore";

/**
 * Canonical form for a path under a given trailing-slash policy.
 *
 * `ignore` is the interesting case: Astro serves both spellings, so the
 * provider will report both, and the two have to be folded into one row
 * or a page's views arrive split in half. We fold onto the trailing-slash
 * spelling because that is what `getPublicUrl()` emits by default.
 */
export function normalizePath(raw: string, trailingSlash: TrailingSlash = "ignore"): string {
	let path = stripOrigin(raw.trim());

	// Query and hash are not part of the page's identity. Cloudflare
	// reports them separately anyway, but a hand-entered filter may not.
	const cut = Math.min(indexOrEnd(path, "?"), indexOrEnd(path, "#"));
	path = path.slice(0, cut);

	path = decodeOnce(path);

	if (!path.startsWith("/")) path = `/${path}`;
	path = path.replace(/\/{2,}/g, "/");

	// The root is "/" under every policy; there is no slash-less spelling.
	if (path === "/") return "/";

	const bare = path.replace(/\/+$/, "") || "/";
	if (bare === "/") return "/";

	return trailingSlash === "never" ? bare : `${bare}/`;
}

/**
 * Canonical spelling of a hostname: case-insensitive by specification, and
 * a trailing dot is the same host.
 *
 * Deliberately does **not** fold `www.` away. `example.com` and
 * `www.example.com` are two distinct `requestHost` values in Cloudflare's
 * data, and both have to survive into `requestHost_in` or the filter drops
 * half the site's traffic. Folding them here once collapsed the host list
 * to a duplicate pair; `siteHosts` is the place that knows both spellings
 * belong to one site.
 */
export function normalizeHost(raw: string): string {
	return raw.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * The hosts a site's beacon may report under, derived from `site.url`.
 *
 * A single Cloudflare site tag routinely covers more than one hostname —
 * one production site's record matched its apex, its `www` host and a
 * `*.pages.dev` preview domain. Filtering on the apex alone would drop the
 * `www` half of the traffic, so both spellings go into `requestHost_in`.
 */
export function siteHosts(siteUrl: string): string[] {
	let host: string;
	try {
		host = new URL(siteUrl).hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return [];
	}
	if (!host) return [];
	const apex = host.replace(/^www\./, "");
	return apex === host ? [apex, `www.${apex}`] : [apex, host];
}

/**
 * Paths the plugin must never count.
 *
 * The admin is an injected Astro page with its own `<head>`, so a beacon
 * injected at `head-inline` runs there too and turns editor sessions into
 * page views, and Cloudflare's automatic setup injects into every HTML
 * response regardless. Provider queries exclude these paths where the
 * provider can filter; this catches what a filter pattern cannot express.
 */
export function isInternalPath(path: string): boolean {
	return path === "/_emdash" || path.startsWith("/_emdash/");
}

function stripOrigin(value: string): string {
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
	try {
		const url = new URL(value);
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return value;
	}
}

function indexOrEnd(value: string, needle: string): number {
	const i = value.indexOf(needle);
	return i === -1 ? value.length : i;
}

/**
 * Percent-decode once, tolerantly.
 *
 * `decodeURIComponent` throws on a malformed sequence such as `%zz`, and
 * a crash inside a sync tick would cost the whole batch. A path we cannot
 * decode is still a usable key, so it is kept verbatim.
 */
function decodeOnce(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
