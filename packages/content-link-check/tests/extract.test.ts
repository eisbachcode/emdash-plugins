import { describe, expect, it } from "vitest";

import { classify, extractLinks, isRelativePath, toRequestUrl } from "../src/extract.js";

const SITE = "https://example.com";

describe("extractLinks", () => {
	it("finds absolute URLs anywhere in the data", () => {
		const links = extractLinks({
			title: "See https://external.test/docs for details",
			meta: { nested: { deep: "http://other.test/page" } },
		});
		expect(links.map((l) => l.url)).toEqual(["https://external.test/docs", "http://other.test/page"]);
	});

	it("strips sentence punctuation from a URL in prose", () => {
		const links = extractLinks({ title: "See https://external.test/docs, then stop." });
		expect(links.map((l) => l.url)).toEqual(["https://external.test/docs"]);
	});

	it("keeps a trailing slash or query that belongs to the URL", () => {
		const links = extractLinks({ href: "https://external.test/docs/?q=1" });
		expect(links.map((l) => l.url)).toEqual(["https://external.test/docs/?q=1"]);
	});

	it("pulls hrefs out of portable text markDefs", () => {
		const links = extractLinks({
			body: [
				{
					_type: "block",
					markDefs: [{ _key: "a1", _type: "link", href: "https://target.test/x" }],
					children: [{ _type: "span", text: "click", marks: ["a1"] }],
				},
			],
		});
		expect(links).toEqual([{ url: "https://target.test/x", path: "body[0].markDefs[0].href" }]);
	});

	it("takes relative paths only under link-ish keys", () => {
		const links = extractLinks({
			href: "/about",
			prose: "/not/a/link, just text with a slash",
		});
		expect(links.map((l) => l.url)).toEqual(["/about"]);
	});

	it("takes relative paths from custom fields named after a link", () => {
		// Field names from a real site whose internal links all went unseen.
		const links = extractLinks({
			cta_url: "/contact",
			hero_cta_url: "/en/contact",
			services_items: [{ link_label: "Mehr", link_href: "/wordpress-zu-emdash" }],
			ctaHref: "/about",
			curl: "/not/a/link",
			blurl: "/not/a/link/either",
		});
		expect(links.map((l) => l.url)).toEqual(["/contact", "/en/contact", "/wordpress-zu-emdash", "/about"]);
	});

	it("deduplicates by url and keeps the first path", () => {
		const links = extractLinks({
			a: { href: "/same" },
			b: { href: "/same" },
		});
		expect(links).toEqual([{ url: "/same", path: "a.href" }]);
	});

	it("ignores empty strings and respects the depth cap", () => {
		expect(extractLinks({ href: "   " })).toEqual([]);
		const deep = { l1: { l2: { l3: { href: "https://too.deep/x" } } } };
		expect(extractLinks(deep, 2)).toEqual([]);
	});
});

describe("classify", () => {
	it("treats same-origin absolute URLs as internal", () => {
		expect(classify("https://example.com/a", SITE)).toBe("internal");
		expect(classify("/a", SITE)).toBe("internal");
		expect(classify("https://elsewhere.test/a", SITE)).toBe("external");
	});

	it("does not crash on junk", () => {
		expect(classify("not a url", SITE)).toBe("external");
	});
});

describe("isRelativePath", () => {
	it("rejects protocol-relative and bare slash", () => {
		expect(isRelativePath("/about")).toBe(true);
		expect(isRelativePath("//cdn.test/x")).toBe(false);
		expect(isRelativePath("/")).toBe(false);
	});
});

describe("toRequestUrl", () => {
	it("resolves relative paths against the site", () => {
		expect(toRequestUrl("/about", SITE)).toBe("https://example.com/about");
	});

	it("returns null for unparseable input", () => {
		expect(toRequestUrl("http://[bad", SITE)).toBeNull();
	});
});
