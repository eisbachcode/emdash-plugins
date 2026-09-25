import type { PluginContext } from "emdash/plugin";
import { describe, expect, it } from "vitest";

import { buildReportPage, buildSettingsPage } from "../src/report.js";
import type { StoredFinding } from "../src/sweep.js";

function finding(slug: string, locale: string): StoredFinding {
	return {
		collection: "pages",
		entryId: `01${slug.toUpperCase()}`,
		slug,
		locale,
		rule: "missing-description",
		severity: "medium",
		detail: "Published without an SEO description.",
		entryUpdatedAt: "2026-09-17T00:00:00.000Z",
		foundAt: "2026-09-24T00:00:00.000Z",
	};
}

function fakeContext(findings: StoredFinding[], kv: Record<string, unknown> = {}) {
	return {
		kv: { get: async (key: string) => kv[key] ?? null },
		schema: { listCollections: async () => [] },
		storage: {
			findings: {
				count: async () => findings.length,
				query: async () => ({ items: findings.map((data) => ({ id: data.entryId, data })), cursor: null }),
			},
		},
	} as unknown as PluginContext;
}

function table(blocks: Array<Record<string, unknown>>) {
	return blocks.find((block) => block.type === "table") as
		| { columns: Array<{ key: string }>; rows: Array<Record<string, string>> }
		| undefined;
}

describe("the findings table", () => {
	it("tells the translations of one page apart on a multilingual site", async () => {
		// Without the language, "about" and "about" read as a duplicate.
		const { blocks } = await buildReportPage(fakeContext([finding("about", "de"), finding("about", "en")]));
		const rows = table(blocks)?.rows ?? [];
		expect(rows.map((row) => row.locale).sort()).toEqual(["de", "en"]);
		expect(table(blocks)?.columns.map((column) => column.key)).toContain("locale");
	});

	it("leaves the language out on a single-language site", async () => {
		const { blocks } = await buildReportPage(fakeContext([finding("about", "en"), finding("contact", "en")]));
		expect(table(blocks)?.columns.map((column) => column.key)).not.toContain("locale");
	});
});

describe("the settings form", () => {
	it("shows the saved values, not blank fields", async () => {
		// Block Kit inputs render `initial_value`; anything else leaves the field empty.
		const { blocks } = await buildSettingsPage(
			fakeContext([], { "settings:staleMonths": 18, "settings:reportMissingDescriptions": false }),
		);
		const form = blocks.find((block) => block.type === "form") as {
			elements: Array<{ action_id: string; initial_value?: unknown }>;
		};
		const value = (id: string) => form.elements.find((element) => element.action_id === id)?.initial_value;
		expect(value("staleMonths")).toBe(18);
		expect(value("reportMissingDescriptions")).toBe(false);
		expect(value("schedule")).toBe("0 4 * * *");
	});
});
