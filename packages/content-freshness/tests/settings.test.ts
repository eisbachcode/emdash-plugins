import { describe, expect, it } from "vitest";

import { applyForm, DEFAULT_SETTINGS, expiryFor, normalizeSettings, thresholdsFor } from "../src/settings.js";

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

describe("settings per collection", () => {
	it("override the site's thresholds, and 0 switches a rule off", () => {
		const next = applyForm(DEFAULT_SETTINGS, {
			"collection:pages:staleMonths": 24,
			"collection:testimonials:staleMonths": 0,
			"collection:testimonials:skip": false,
		});
		expect(thresholdsFor(next, "pages").staleMonths).toBe(24);
		expect(thresholdsFor(next, "testimonials").staleMonths).toBe(0);
		expect(thresholdsFor(next, "posts").staleMonths).toBe(DEFAULT_SETTINGS.staleMonths);
	});

	it("fall back to the site's value when the field is emptied", () => {
		const current = applyForm(DEFAULT_SETTINGS, { "collection:pages:staleMonths": 24 });
		// The admin leaves an emptied number field out of the submission.
		const next = applyForm(current, { "collection:pages:skip": false }, ["pages"]);
		expect(thresholdsFor(next, "pages").staleMonths).toBe(DEFAULT_SETTINGS.staleMonths);
		expect(next.collections).toEqual({});
	});

	it("keep the overrides of collections the form did not show", () => {
		const current = applyForm(DEFAULT_SETTINGS, { "collection:archive:staleMonths": 36 });
		expect(thresholdsFor(applyForm(current, {}, ["pages"]), "archive").staleMonths).toBe(36);
	});

	it("drop an override that is not a number instead of switching the rule off", () => {
		const next = normalizeSettings({ collections: { pages: { staleMonths: "abc", draftMonths: Number.NaN } } });
		expect(thresholdsFor(next, "pages").staleMonths).toBe(DEFAULT_SETTINGS.staleMonths);
		expect(next.collections).toEqual({});
	});

	it("leave a collection out of the audit", () => {
		const next = applyForm(DEFAULT_SETTINGS, { "collection:legal:skip": true });
		expect(thresholdsFor(next, "legal").skip).toBe(true);
	});

	it("drop what is not a collection slug", () => {
		expect(normalizeSettings({ collections: { "Bad Slug": { skip: true }, pages: "nonsense" } }).collections).toEqual({});
	});
});

describe("the expiry field of a collection", () => {
	const dates = [
		{ slug: "starts_on", label: "Starts" },
		{ slug: "valid_until", label: "Valid until" },
	];

	it("is detected from the field names unless the settings say otherwise", () => {
		expect(expiryFor(DEFAULT_SETTINGS, "offers", dates)).toEqual({ slug: "valid_until", label: "Valid until" });
	});

	it("can be chosen, or switched off", () => {
		const chosen = applyForm(DEFAULT_SETTINGS, { "collection:offers:expiryField": "starts_on" });
		expect(expiryFor(chosen, "offers", dates)).toEqual({ slug: "starts_on", label: "Starts" });
		const off = applyForm(DEFAULT_SETTINGS, { "collection:offers:expiryField": "off" });
		expect(expiryFor(off, "offers", dates)).toBeNull();
	});

	it("goes back to detection for auto, or for a field the collection no longer has", () => {
		const chosen = applyForm(DEFAULT_SETTINGS, { "collection:offers:expiryField": "starts_on" });
		expect(applyForm(chosen, { "collection:offers:expiryField": "auto" }).collections).toEqual({});
		const gone = applyForm(DEFAULT_SETTINGS, { "collection:offers:expiryField": "removed_field" });
		expect(expiryFor(gone, "offers", dates)?.slug).toBe("valid_until");
	});
});
