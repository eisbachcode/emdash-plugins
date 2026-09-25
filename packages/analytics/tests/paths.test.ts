import { describe, expect, it } from "vitest";

import { isInternalPath, normalizeHost, normalizePath, siteHosts } from "../src/index/paths.js";

describe("normalizePath", () => {
	it("folds the two spellings Cloudflare actually reported", () => {
		// Straight from the 2026-09-20 pull: one page, two rows.
		expect(normalizePath("/datenschutz")).toBe(normalizePath("/datenschutz/"));
	});

	it("honours an explicit trailing-slash policy", () => {
		expect(normalizePath("/impressum", "always")).toBe("/impressum/");
		expect(normalizePath("/impressum/", "always")).toBe("/impressum/");
		expect(normalizePath("/impressum", "never")).toBe("/impressum");
		expect(normalizePath("/impressum/", "never")).toBe("/impressum");
	});

	it("keeps the root as / under every policy", () => {
		for (const policy of ["always", "never", "ignore"] as const) {
			expect(normalizePath("/", policy)).toBe("/");
			expect(normalizePath("", policy)).toBe("/");
			expect(normalizePath("///", policy)).toBe("/");
		}
	});

	it("drops query and hash", () => {
		expect(normalizePath("/blog/?utm_source=newsletter")).toBe("/blog/");
		expect(normalizePath("/blog#section")).toBe("/blog/");
		expect(normalizePath("/blog?a=1#b")).toBe("/blog/");
	});

	it("percent-decodes so encoded and plain spellings agree", () => {
		expect(normalizePath("/%C3%BCber-uns/")).toBe("/über-uns/");
		expect(normalizePath("/über-uns")).toBe("/über-uns/");
	});

	it("keeps a path it cannot decode rather than throwing", () => {
		// A crash here would cost the whole sync batch.
		expect(() => normalizePath("/bad%zz/")).not.toThrow();
		expect(normalizePath("/bad%zz/")).toBe("/bad%zz/");
	});

	it("collapses repeated slashes and adds the leading one", () => {
		expect(normalizePath("blog/post")).toBe("/blog/post/");
		expect(normalizePath("//blog///post//")).toBe("/blog/post/");
	});

	it("accepts an absolute URL and keeps only the path", () => {
		expect(normalizePath("https://example.com/kontakt/")).toBe("/kontakt/");
		expect(normalizePath("https://example.com/kontakt?x=1")).toBe("/kontakt/");
	});

	it("does not fold case, because paths are case-sensitive", () => {
		expect(normalizePath("/Impressum/")).not.toBe(normalizePath("/impressum/"));
	});

	it("does not strip a leading segment that looks like a locale", () => {
		// `/de/` is a locale on one site and a page on another. The index is
		// built forward from getPublicUrl, so both sides already agree.
		expect(normalizePath("/de/blog/")).toBe("/de/blog/");
	});
});

describe("normalizeHost", () => {
	it("folds case and the trailing dot", () => {
		expect(normalizeHost("EXAMPLE.com")).toBe("example.com");
		expect(normalizeHost("example.com.")).toBe("example.com");
	});

	it("keeps www, because it is a distinct requestHost value", () => {
		// Folding it here collapsed the host allow-list into a duplicate
		// pair and would have dropped every www visit from the filter.
		expect(normalizeHost("www.example.com")).toBe("www.example.com");
		expect(normalizeHost("www.example.com")).not.toBe(normalizeHost("example.com"));
	});
});

describe("siteHosts", () => {
	it("covers apex and www, because one site tag carries both", () => {
		expect(siteHosts("https://example.com")).toEqual(["example.com", "www.example.com"]);
		expect(siteHosts("https://www.example.com/")).toEqual(["example.com", "www.example.com"]);
	});

	it("returns nothing usable for a site URL it cannot parse", () => {
		expect(siteHosts("not a url")).toEqual([]);
		expect(siteHosts("")).toEqual([]);
	});
});

describe("isInternalPath", () => {
	it("recognises admin traffic", () => {
		expect(isInternalPath("/_emdash")).toBe(true);
		expect(isInternalPath("/_emdash/admin/dashboard")).toBe(true);
	});

	it("does not catch a page that merely starts with the same letters", () => {
		expect(isInternalPath("/_emdashboard/")).toBe(false);
		expect(isInternalPath("/blog/")).toBe(false);
	});
});
