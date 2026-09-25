import { describe, expect, it } from "vitest";

import { clampNumber, parseCollections } from "../src/values.js";

describe("parseCollections", () => {
	it("splits, trims, drops blanks and duplicates", () => {
		expect(parseCollections(" posts , pages ,, posts ")).toEqual(["posts", "pages"]);
	});

	it("returns nothing for a non-string", () => {
		expect(parseCollections(undefined)).toEqual([]);
		expect(parseCollections(["posts"])).toEqual([]);
	});
});

describe("clampNumber", () => {
	it("clamps, truncates and falls back", () => {
		expect(clampNumber(9999, 1, 500, 25)).toBe(500);
		expect(clampNumber(0, 1, 500, 25)).toBe(1);
		expect(clampNumber(3.7, 1, 500, 25)).toBe(3);
		expect(clampNumber("nonsense", 1, 500, 25)).toBe(25);
	});

	it("falls back for an absent value rather than clamping to min", () => {
		// ctx.kv.get answers null for an unset key. Number(null) is 0.
		expect(clampNumber(null, 1, 500, 25)).toBe(25);
		expect(clampNumber(undefined, 1, 500, 25)).toBe(25);
		expect(clampNumber("", 1, 500, 25)).toBe(25);
		expect(clampNumber(true, 1, 500, 25)).toBe(25);
	});
});
