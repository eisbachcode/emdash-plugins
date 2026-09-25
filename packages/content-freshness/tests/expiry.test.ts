import { validateBlocks } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { PANEL_ID } from "../src/panel.js";
import { finding, runSweep } from "./host.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

/** A collection of offers with a `valid_until` date, and one offer that ran out. */
async function offers() {
	const runtime = await createPluginRuntimeTestHost();
	await runtime.fixtures.collection({
		slug: "offers",
		label: "Offers",
		routable: true,
		urlPattern: "/offers/{slug}",
		fields: [{ slug: "valid_until", label: "Valid until", type: "datetime" }],
	});
	const entry = await runtime.fixtures.content("offers", {
		slug: "summer-sale",
		data: { valid_until: "2026-01-31" },
		status: "published",
	});
	return { runtime, entry };
}

describe("an entry whose expiry date has passed", () => {
	it("is found by the sweep through the detected field", async () => {
		const { runtime, entry } = await offers();
		host = runtime;
		await runSweep(runtime);

		const row = await finding(runtime, "offers", entry.id);
		expect(row?.hits).toContainEqual(expect.objectContaining({ rule: "expired", params: expect.objectContaining({ field: "Valid until" }) }));
	});

	it("shows in its panel, where it can be ignored", async () => {
		const { runtime, entry } = await offers();
		host = runtime;
		const panel = await runtime.admin.loadEditorPanel(PANEL_ID, "offers", entry.id);
		expect(validateBlocks(panel.blocks).valid).toBe(true);
		expect(JSON.stringify(panel.blocks)).toContain("Valid until was 2026-01-31");
		expect(JSON.stringify(panel.blocks)).toContain("Ignore");
	});

	it("lets the settings name the field, or switch expiry off", async () => {
		const { runtime, entry } = await offers();
		host = runtime;
		const page = await runtime.admin.loadPage("/settings");
		expect(validateBlocks(page.blocks).valid).toBe(true);
		expect(JSON.stringify(page.blocks)).toContain("Detected: Valid until");

		await runtime.admin.submit("/settings", "save_settings", { "collection:offers:expiryField": "off" });
		await runtime.admin.loadEditorPanel(PANEL_ID, "offers", entry.id);
		expect(await finding(runtime, "offers", entry.id)).toBeNull();
	});
});
