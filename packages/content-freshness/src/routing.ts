/**
 * The one check that is about a collection, not an entry.
 *
 * Without a URL pattern, EmDash builds every public URL for a collection as
 * `/{collection}/{slug}`: in the sitemap, in the admin's view links, and for
 * plugins asking for an entry's URL. A site whose routes differ (`/blog/…`,
 * `/{slug}`, a single page at `/about`) then publishes a sitemap of 404s,
 * and nothing reports it.
 */

import type { PluginCollectionInfo } from "@eisbachcode/emdash-plugin-shared";

/** Routable collections that fall back to `/{collection}/{slug}`. */
export function collectionsWithoutUrlPattern(collections: PluginCollectionInfo[]): PluginCollectionInfo[] {
	return collections.filter((collection) => collection.routable && !collection.urlPattern);
}
