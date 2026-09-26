import type { PluginContext } from "emdash/plugin";
import { describe, expect, it } from "vitest";

import { buildReportPage, buildSettingsPage } from "../src/report.js";
import { settingsFrom } from "../src/settings.js";
import type { CheckRow, Place } from "../src/store.js";

function place(entrySlug: string | null, locale: string): Place {
	return {
		url: "/privacy-policy",
		path: "content[45].markDefs[0].href",
		collection: "pages",
		entryId: `01M2RABGX6C6AYNDFBV542M7D5-${locale}`,
		entrySlug,
		locale,
	};
}

function redirect(target: string, places: Place[], placeCount = places.length): CheckRow {
	return {
		target,
		scope: "internal",
		state: "redirect",
		reason: null,
		status: 301,
		location: "/datenschutz",
		finalUrl: null,
		error: null,
		consecutiveFailures: 0,
		firstFailedAt: null,
		reported: true,
		finding: "redirect",
		checkedAt: "2026-09-24T00:00:00.000Z",
		firstSeenAt: "2026-09-24T00:00:00.000Z",
		seenAt: "2026-09-24T00:00:00.000Z",
		lastPage: "",
		places,
		placeCount,
	};
}

/** Storage that answers every query with all its rows; the where clauses are emdash's to test. */
function fakeContext(checks: CheckRow[]) {
	return {
		storage: {
			checks: {
				count: async () => checks.length,
				query: async () => ({ items: checks.map((data) => ({ id: data.target, data })), cursor: null }),
			},
		},
	} as unknown as PluginContext;
}

function table(blocks: Array<Record<string, unknown>>) {
	return blocks.find((block) => block.type === "table") as
		| { columns: Array<{ key: string }>; rows: Array<Record<string, string>> }
		| undefined;
}

describe("the link report", () => {
	it("names each finding's entry by its slug, and its language on a multilingual site", async () => {
		const { blocks } = await buildReportPage(
			fakeContext([
				redirect("https://example.test/datenschutz-alt", [place("datenschutz", "de")]),
				redirect("https://example.test/privacy-old", [place("privacy", "en")]),
			]),
		);
		const rows = table(blocks)?.rows ?? [];
		expect(rows.map((row) => [row.entry, row.locale]).sort()).toEqual([
			["pages/datenschutz", "de"],
			["pages/privacy", "en"],
		]);
	});

	it("lists a link once, however many entries it appears in", async () => {
		const shared = redirect("https://example.test/privacy-policy", [place("datenschutz", "de"), place("privacy", "de")], 12);
		const { blocks } = await buildReportPage(fakeContext([shared]));
		expect(table(blocks)?.rows.map((row) => row.entry)).toEqual(["pages/datenschutz +11 more"]);
	});

	it("falls back to the id for an entry without a slug", async () => {
		const { blocks } = await buildReportPage(
			fakeContext([redirect("https://example.test/privacy-policy", [place(null, "de")])]),
		);
		expect(table(blocks)?.rows[0]?.entry).toBe("pages/01M2RABGX6C6AYNDFBV542M7D5-de");
		expect(table(blocks)?.columns.map((column) => column.key)).not.toContain("locale");
	});
});

describe("the settings form", () => {
	it("shows the saved values, not blank fields", async () => {
		// Block Kit inputs render `initial_value`. With anything else the outbound
		// toggle showed as off while the plugin was still checking outbound links.
		const { blocks } = buildSettingsPage(settingsFrom({ batchSize: 10 }));
		const form = blocks.find((block) => block.type === "form") as {
			fields: Array<{ action_id: string; initial_value?: unknown }>;
		};
		const value = (id: string) => form.fields.find((field) => field.action_id === id)?.initial_value;
		expect(value("batchSize")).toBe(10);
		expect(value("checkExternal")).toBe(true);
		expect(value("schedule")).toBe("0 3 * * *");
	});
});
