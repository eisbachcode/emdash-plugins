import type { Block, FormBlock, TableBlock } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";
import { describe, expect, it } from "vitest";

import type { EntryFindings } from "../src/findings.js";
import { buildReportPage, buildSettingsPage } from "../src/report.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import type { State } from "../src/state.js";

const STATE: State = { sweep: null, lastFinishedAt: "2026-09-24T04:10:00.000Z" };

function row(slug: string, locale: string): EntryFindings {
	return {
		collection: "pages",
		entryId: `01${slug.toUpperCase()}`,
		slug,
		locale,
		rank: 1,
		hits: [{ rule: "missing-description", severity: "medium", params: {} }],
		entryUpdatedAt: "2026-09-17T00:00:00.000Z",
		seenIn: "2026-09-24T04:00:00.000Z",
	};
}

function fakeContext(rows: EntryFindings[]) {
	return {
		schema: { listCollections: async () => [] },
		storage: {
			findings: {
				count: async (where?: { rank?: number }) => rows.filter((r) => r.rank === where?.rank).length,
				query: async () => ({
					items: rows.map((data) => ({ id: `${data.collection}:${data.entryId}`, data })),
					hasMore: false,
				}),
			},
		},
	} as unknown as PluginContext;
}

function table(blocks: Block[]) {
	return blocks.find((block): block is TableBlock => block.type === "table");
}

describe("the findings table", () => {
	it("tells the translations of one page apart on a multilingual site", async () => {
		// Without the language, "about" and "about" read as a duplicate.
		const { blocks } = await buildReportPage(fakeContext([row("about", "de"), row("about", "en")]), STATE);
		expect(table(blocks)?.rows.map((r) => r.locale).sort()).toEqual(["de", "en"]);
		expect(table(blocks)?.columns.map((column) => column.key)).toContain("locale");
	});

	it("leaves the language out on a single-language site", async () => {
		const { blocks } = await buildReportPage(fakeContext([row("about", "en"), row("contact", "en")]), STATE);
		expect(table(blocks)?.columns.map((column) => column.key)).not.toContain("locale");
	});

	it("names the priority and every finding of an entry in one row", async () => {
		const entry = row("about", "en");
		entry.hits.push({ rule: "stale", severity: "medium", params: { since: "2024-05-01" } });
		const { blocks } = await buildReportPage(fakeContext([entry]), STATE);
		const [first] = table(blocks)?.rows ?? [];
		expect(first?.priority).toBe("Should fix");
		expect(first?.findings).toContain("SEO description");
		expect(first?.findings).toContain("2024-05-01");
	});
});

describe("the settings form", () => {
	it("shows the saved values, not blank fields", () => {
		// Block Kit inputs render `initial_value`; anything else leaves the field empty.
		const { blocks } = buildSettingsPage({ ...DEFAULT_SETTINGS, staleMonths: 18, reportMissingDescriptions: false });
		const form = blocks.find((block): block is FormBlock => block.type === "form");
		const value = (id: string) => {
			const field = form?.fields.find((f) => "action_id" in f && f.action_id === id);
			return field && "initial_value" in field ? field.initial_value : undefined;
		};
		expect(value("staleMonths")).toBe(18);
		expect(value("reportMissingDescriptions")).toBe(false);
		expect(value("schedule")).toBe("0 4 * * *");
	});
});
