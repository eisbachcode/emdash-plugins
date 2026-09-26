/**
 * Link extraction — pure functions, no `ctx`, no network.
 *
 * Deliberately schema-agnostic. Field definitions rarely say which strings
 * are links: sites store them in plain `string` fields and inside repeaters
 * as often as in `url` fields. So instead of knowing where links live, this
 * walks the entry's `data` and picks up anything that unambiguously is one:
 *
 *   - every `http(s)` URL appearing in any string value, wherever it sits
 *     — a bare URL pasted into prose counts, and so does Portable Text's
 *     `markDefs[].href`, which is just an `href` key a few levels down;
 *   - site-relative paths (`/about`), but only under keys that mean
 *     "this is a link" (`href`, or a name ending in one, like `cta_url`) —
 *     otherwise ordinary prose containing a slash would be collected as a
 *     link.
 *
 * The trade is deliberate: this over-collects slightly (a URL written in
 * a code sample is indistinguishable from a real link) and never
 * under-collects. A false positive shows up in the report as a link that
 * resolves fine; a false negative is a broken link nobody sees.
 */

/** One link, with where it was found, for the report table. */
export interface ExtractedLink {
	/** The href exactly as written in the content. */
	url: string;
	/** Dotted path into the entry data, e.g. `body[2].markDefs[0].href`. */
	path: string;
}

/** Keys whose string values are treated as links even when relative. */
const LINK_KEYS = new Set(["href", "url", "canonical", "link", "src", "image"]);

/** Custom field names ending in a link word: `cta_url`, `link_href`, `ctaHref`. */
const LINK_KEY_SUFFIX = /(?:[_-](?:url|href|link)|[a-z0-9](?:Url|Href|Link))$/;

function isLinkKey(key: string): boolean {
	return LINK_KEYS.has(key) || LINK_KEY_SUFFIX.test(key);
}

/** Whole-string absolute URL. */
const ABSOLUTE = /^https?:\/\//i;

/**
 * URL-shaped substrings, for a bare URL sitting inside prose. Stops at
 * whitespace and at the characters that normally *enclose* a URL rather
 * than belong to it.
 */
const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/gi;

/** Punctuation that ends the sentence, not the URL. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * Depth cap. Content is JSON, so there are no cycles to guard against,
 * but a sandboxed invocation has a 50 ms CPU budget and a pathological
 * nesting depth is not worth spending it on.
 */
const MAX_DEPTH = 12;

/**
 * Collect every link in an entry's `data` (and its `seo` block, if the
 * caller merges it in). Deduplicated by URL, first path wins, order
 * stable so the report does not reshuffle between sweeps.
 */
export function extractLinks(data: unknown, maxDepth: number = MAX_DEPTH): ExtractedLink[] {
	const found = new Map<string, string>();

	const visit = (value: unknown, path: string, key: string | null, depth: number): void => {
		if (depth > maxDepth) return;

		if (typeof value === "string") {
			const trimmed = value.trim();
			if (!trimmed) return;

			// A field holding exactly one URL is the common case; scanning
			// covers the rest, including a URL mid-sentence.
			for (const match of trimmed.match(URL_IN_TEXT) ?? []) {
				const url = ABSOLUTE.test(trimmed) && match === trimmed ? trimmed : match.replace(TRAILING_PUNCTUATION, "");
				if (url && !found.has(url)) found.set(url, path);
			}

			if (key !== null && isLinkKey(key) && isRelativePath(trimmed) && !found.has(trimmed)) {
				found.set(trimmed, path);
			}
			return;
		}

		if (Array.isArray(value)) {
			value.forEach((item, index) => visit(item, `${path}[${index}]`, null, depth + 1));
			return;
		}

		if (value !== null && typeof value === "object") {
			for (const [childKey, childValue] of Object.entries(value)) {
				const childPath = path ? `${path}.${childKey}` : childKey;
				visit(childValue, childPath, childKey, depth + 1);
			}
		}
	};

	visit(data, "", null, 0);
	return [...found].map(([url, path]) => ({ url, path }));
}

/**
 * A site-relative path: starts with a single slash, and is not a
 * protocol-relative URL (`//host`) or a bare slash.
 */
export function isRelativePath(value: string): boolean {
	return value.startsWith("/") && !value.startsWith("//") && value.length > 1;
}

/** Where a link points, relative to this site. */
export type LinkScope = "internal" | "external";

/**
 * Classify a link against the site's own origin. A same-origin absolute
 * URL counts as internal — editors paste those constantly, and treating
 * them as external would check the site from the outside for no reason.
 */
export function classify(url: string, siteUrl: string): LinkScope {
	if (isRelativePath(url)) return "internal";
	try {
		return new URL(url).origin === new URL(siteUrl).origin ? "internal" : "external";
	} catch {
		return "external";
	}
}

/**
 * Absolute URL to actually request. Relative paths are resolved against
 * the site origin. Returns `null` for anything that will not parse, so
 * the caller can record it as malformed rather than fetch garbage.
 */
export function toRequestUrl(url: string, siteUrl: string): string | null {
	try {
		return new URL(url, siteUrl).toString();
	} catch {
		return null;
	}
}
