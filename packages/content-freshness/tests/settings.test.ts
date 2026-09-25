import { describe, expect, it } from "vitest";

import { applyForm, DEFAULT_SETTINGS, normalizeSettings } from "../src/settings.js";

describe("normalizeSettings", () => {
	it("returns defaults for nothing stored", () => {
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});

	it("orders the description bounds even if they are stored the wrong way round", () => {
		const settings = normalizeSettings({ descriptionMin: 200, descriptionMax: 40 });
		expect([settings.descriptionMin, settings.descriptionMax]).toEqual([40, 200]);
	});

	it("caps the page size below D1's bind limit", () => {
		// A page's ids go into one `IN (...)` next to two bound values of
		// storage's own; D1 allows 100 per statement.
		expect(normalizeSettings({ pageSize: 100 }).pageSize).toBe(98);
	});
});

describe("applyForm", () => {
	it("clamps numbers and ignores unknown keys", () => {
		const next = applyForm(DEFAULT_SETTINGS, { staleMonths: 9999, nonsense: true });
		expect(next.staleMonths).toBe(120);
		expect(next).not.toHaveProperty("nonsense");
	});

	it("keeps values the form did not send", () => {
		const current = { ...DEFAULT_SETTINGS, draftMonths: 3 };
		expect(applyForm(current, { staleMonths: 18 })).toMatchObject({ staleMonths: 18, draftMonths: 3 });
	});
});
