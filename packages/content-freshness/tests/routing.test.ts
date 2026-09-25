import type { PluginContext } from "emdash/plugin";
import { describe, expect, it } from "vitest";

import { buildReportPage, buildWidget } from "../src/report.js";

/**
 * A routable collection without a URL pattern gets `/{collection}/{slug}`
 * URLs in EmDash's sitemap. On a site that routes posts at `/aktuelles/…`
 * and pages at `/{slug}`, every one of them is a 404, and nothing else in
 * the admin says so.
 */

type Collection = { slug: string; label: string; routable: boolean; urlPattern: string | null };

function fakeContext(collections: Collection[]) {
	return {
		kv: { get: async () => null },
		schema: { listCollections: async () => collections },
		storage: {
			findings: {
				count: async () => 0,
				query: async () => ({ items: [], cursor: null }),
			},
		},
	} as unknown as PluginContext;
}

function banners(blocks: Array<Record<string, unknown>>) {
	return blocks.filter((block) => block.type === "banner");
}

describe("the URL pattern warning", () => {
	it("names routable collections that fall back to /{collection}/{slug}", async () => {
		const ctx = fakeContext([
			{ slug: "posts", label: "Posts", routable: true, urlPattern: null },
			{ slug: "pages", label: "Pages", routable: true, urlPattern: "/{slug}" },
			{ slug: "authors", label: "Authors", routable: false, urlPattern: null },
		]);

		const { blocks } = await buildReportPage(ctx);
		const [banner] = banners(blocks);
		expect(banner?.title).toContain("Posts");
		expect(banner?.title).not.toContain("Pages");
		expect(banner?.title).not.toContain("Authors");
	});

	it("reaches the dashboard even when no entry has a finding", async () => {
		const ctx = fakeContext([{ slug: "posts", label: "Posts", routable: true, urlPattern: null }]);
		const { blocks } = await buildWidget(ctx);
		expect(banners(blocks)).toHaveLength(1);
	});

	it("stays out of the way when every routable collection has a pattern", async () => {
		const ctx = fakeContext([{ slug: "posts", label: "Posts", routable: true, urlPattern: "/blog/{slug}" }]);
		expect(banners((await buildReportPage(ctx)).blocks)).toHaveLength(0);
		expect(banners((await buildWidget(ctx)).blocks)).toHaveLength(0);
	});
});
