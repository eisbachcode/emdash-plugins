import { validateBlocks } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { PANEL_ID, SET_ASIDE_ACTION } from "../src/panel.js";
import { SAVE_SETTINGS_ACTION } from "../src/report.js";
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
	// How EmDash stores 31 January for a site in Berlin.
	const entry = await runtime.fixtures.content("offers", {
		slug: "summer-sale",
		data: { valid_until: "2026-01-30T23:00:00.000Z" },
		status: "published",
	});
	return { runtime, entry };
}

const chooseField = (runtime: PluginRuntimeTestHost, value: string) =>
	runtime.admin.submit("/settings", SAVE_SETTINGS_ACTION, { "collection:offers:expiryField": value });

describe("expiry", () => {
	it("is suggested in the report, and checks nothing until the field is chosen", async () => {
		const { runtime, entry } = await offers();
		host = runtime;
		await runSweep(runtime);

		expect(await finding(runtime, "offers", entry.id)).toBeNull();
		const report = await runtime.admin.loadPage("/report");
		expect(validateBlocks(report.blocks).valid).toBe(true);
		expect(JSON.stringify(report.blocks)).toContain("Expiry dates not checked: Offers (Valid until)");
		const settings = await runtime.admin.loadPage("/settings");
		expect(validateBlocks(settings.blocks).valid).toBe(true);
		expect(JSON.stringify(settings.blocks)).toContain("Valid until (suggested)");
	});

	it("reports an expired entry once the field is chosen, naming the instant in UTC", async () => {
		const { runtime, entry } = await offers();
		host = runtime;
		await chooseField(runtime, "valid_until");
		await runSweep(runtime);

		const row = await finding(runtime, "offers", entry.id);
		expect(row?.hits).toContainEqual(
			expect.objectContaining({ rule: "expired", params: { field: "Valid until", date: "2026-01-30 23:00 UTC" } }),
		);
		expect(JSON.stringify((await runtime.admin.loadPage("/report")).blocks)).not.toContain("Expiry dates not checked");
	});

	it("comes back after an ignore once the date moved and passed again", async () => {
		const { runtime, entry } = await offers();
		host = runtime;
		await chooseField(runtime, "valid_until");
		await runtime.admin.actEditorPanel(PANEL_ID, "offers", entry.id, SET_ASIDE_ACTION, { value: { rule: "expired" } });
		expect(await finding(runtime, "offers", entry.id)).toBeNull();

		// Next season's offer, which has run out as well. The collection keeps
		// revisions, so the new date is live once it is published.
		await runtime.actions.content.update("offers", entry.id, { data: { valid_until: "2026-08-31T22:00:00.000Z" } });
		await runtime.actions.content.publish("offers", entry.id);
		const panel = await runtime.admin.loadEditorPanel(PANEL_ID, "offers", entry.id);

		expect(JSON.stringify(panel.blocks)).toContain("2026-08-31 22:00 UTC");
		expect(await finding(runtime, "offers", entry.id)).not.toBeNull();
	});

	it("is neither checked nor suggested once a collection never expires", async () => {
		const { runtime } = await offers();
		host = runtime;
		await chooseField(runtime, "off");
		expect(JSON.stringify((await runtime.admin.loadPage("/report")).blocks)).not.toContain("Expiry dates not checked");
	});
});
