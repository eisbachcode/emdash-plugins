import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { langOf } from "../src/i18n.js";
import { PANEL_ID } from "../src/panel.js";
import { newHost, runSweep, undescribed } from "./host.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

describe("the admin language", () => {
	it("is German for every German locale and English otherwise", () => {
		expect(["de", "de-AT", "de_CH"].map(langOf)).toEqual(["de", "de", "de"]);
		expect(["en", "fr", undefined].map(langOf)).toEqual(["en", "en", "en"]);
	});

	it("carries into the report, the widget and the panel", async () => {
		host = await newHost();
		const entry = await undescribed(host, "posts", "auf-deutsch");
		await runSweep(host);

		const report = JSON.stringify((await host.admin.loadPage("/report", { locale: "de" })).blocks);
		expect(report).toContain("Aktualität der Inhalte");
		expect(report).toContain("Veröffentlicht ohne SEO-Beschreibung.");

		const widget = JSON.stringify((await host.admin.loadWidget("summary", { locale: "de" })).blocks);
		expect(widget).toContain("Bericht öffnen");

		const panel = JSON.stringify((await host.admin.loadEditorPanel(PANEL_ID, "posts", entry.id, { locale: "de" })).blocks);
		expect(panel).toContain("Ignorieren");
	});
});
