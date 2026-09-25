import type { BannerBlock, Block } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import { describe, expect, it } from "vitest";

import { buildReportPage, buildWidget } from "../src/report.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import type { State } from "../src/state.js";

/**
 * A routable collection without a URL pattern gets `/{collection}/{slug}`
 * URLs in EmDash's sitemap. On a site that routes posts at `/aktuelles/…`
 * and pages at `/{slug}`, every one of them is a 404, and nothing else in
 * the admin says so.
 */

type Collection = { slug: string; label: string; routable: boolean; urlPattern: string | null };

const STATE: State = { sweep: null, lastFinishedAt: null };

function fakeContext(collections: Collection[]) {
	return {
		schema: { listCollections: async () => collections.map((item) => ({ fields: [], supports: [], ...item })) },
		storage: {
			findings: {
				count: async () => 0,
				query: async () => ({ items: [], hasMore: false }),
			},
		},
	} as unknown as PluginContext;
}

function banners(blocks: Block[]) {
	return blocks.filter((block): block is BannerBlock => block.type === "banner");
}

describe("the URL pattern warning", () => {
	it("names routable collections that fall back to /{collection}/{slug}", async () => {
		const ctx = fakeContext([
			{ slug: "posts", label: "Posts", routable: true, urlPattern: null },
			{ slug: "pages", label: "Pages", routable: true, urlPattern: "/{slug}" },
			{ slug: "authors", label: "Authors", routable: false, urlPattern: null },
		]);

		const { blocks } = await buildReportPage(ctx, STATE, DEFAULT_SETTINGS, "en");
		const [banner] = banners(blocks);
		expect(banner?.title).toContain("Posts");
		expect(banner?.title).not.toContain("Pages");
		expect(banner?.title).not.toContain("Authors");
	});

	it("reaches the dashboard even when no entry has a finding", async () => {
		const ctx = fakeContext([{ slug: "posts", label: "Posts", routable: true, urlPattern: null }]);
		const { blocks } = await buildWidget(ctx, STATE, "en");
		expect(banners(blocks)).toHaveLength(1);
	});

	it("stays out of the way when every routable collection has a pattern", async () => {
		const ctx = fakeContext([{ slug: "posts", label: "Posts", routable: true, urlPattern: "/blog/{slug}" }]);
		expect(banners((await buildReportPage(ctx, STATE, DEFAULT_SETTINGS, "en")).blocks)).toHaveLength(0);
		expect(banners((await buildWidget(ctx, STATE, "en")).blocks)).toHaveLength(0);
	});
});
