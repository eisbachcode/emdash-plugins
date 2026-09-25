import type { ActionsBlock, Block, ButtonElement, ContextBlock, FormBlock, SectionBlock, SelectElement } from "@emdash-cms/blocks";
import { validateBlocks } from "@emdash-cms/blocks/server";
import type { PluginContext } from "emdash/plugin";
import { describe, expect, it } from "vitest";

import type { EntryFindings } from "../src/findings.js";
import { buildReportPage, buildSettingsPage, VIEW_ACTION, viewFrom, type ReportView } from "../src/report.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import type { State } from "../src/state.js";

const STATE: State = { sweep: null, lastFinishedAt: "2026-09-24T04:10:00.000Z" };

function row(slug: string, locale: string, extra: Partial<EntryFindings> = {}): EntryFindings {
	return {
		collection: "pages",
		entryId: `01${slug.toUpperCase()}`,
		slug,
		title: null,
		locale,
		authorId: null,
		rank: 1,
		hits: [{ rule: "missing-description", severity: "medium", params: {} }],
		entryUpdatedAt: "2026-09-17T00:00:00.000Z",
		seenIn: "2026-09-24T04:00:00.000Z",
		...extra,
	};
}

function fakeContext(rows: EntryFindings[], more = false) {
	return {
		schema: {
			listCollections: async () => [
				{ slug: "pages", label: "Pages", routable: true, urlPattern: "/{slug}", fields: [], supports: [] },
				{ slug: "posts", label: "Posts", routable: true, urlPattern: "/blog/{slug}", fields: [], supports: [] },
			],
		},
		storage: {
			findings: {
				count: async (where?: { rank?: number }) => rows.filter((r) => r.rank === where?.rank).length,
				query: async () => ({
					items: rows.map((data) => ({ id: `${data.collection}:${data.entryId}`, data })),
					hasMore: more,
					...(more ? { cursor: "next-page" } : {}),
				}),
			},
		},
	} as unknown as PluginContext;
}

const sections = (blocks: Block[]) => blocks.filter((block): block is SectionBlock => block.type === "section");
const contexts = (blocks: Block[]) => blocks.filter((block): block is ContextBlock => block.type === "context");
const selects = (blocks: Block[]) =>
	blocks
		.filter((block): block is ActionsBlock => block.type === "actions")
		.flatMap((block) => block.elements)
		.filter((element): element is SelectElement => element.type === "select");
const buttons = (blocks: Block[]) =>
	blocks
		.filter((block): block is ActionsBlock => block.type === "actions")
		.flatMap((block) => block.elements)
		.filter((element): element is ButtonElement => element.type === "button");

describe("the report's entries", () => {
	it("link each entry to its editor, in its language", async () => {
		const { blocks } = await buildReportPage(fakeContext([row("about", "de", { title: "Über uns" })]), STATE, DEFAULT_SETTINGS, "en");
		const [section] = sections(blocks);
		expect(section?.text).toContain("Über uns");
		expect(section?.accessory).toMatchObject({
			type: "link",
			target: { kind: "content", collection: "pages", id: "01ABOUT", locale: "de" },
		});
	});

	it("name the collection by its label and the priority before the findings", async () => {
		const entry = row("about", "en");
		entry.hits.push({ rule: "stale", severity: "medium", params: { since: "2024-05-01" } });
		const { blocks } = await buildReportPage(fakeContext([entry]), STATE, DEFAULT_SETTINGS, "en");
		expect(sections(blocks)[0]?.text).toBe("about · Pages");
		const findings = contexts(blocks).find((block) => block.text.startsWith("Should fix:"));
		expect(findings?.text).toContain("SEO description");
		expect(findings?.text).toContain("2024-05-01");
	});

	it("tell the translations of one page apart on a multilingual site", async () => {
		// Without the language, "about" and "about" read as a duplicate.
		const { blocks } = await buildReportPage(fakeContext([row("about", "de"), row("about", "en")]), STATE, DEFAULT_SETTINGS, "en");
		expect(sections(blocks).map((section) => section.text).sort()).toEqual(["about · Pages · de", "about · Pages · en"]);
	});

	it("leave the language out on a single-language site", async () => {
		const { blocks } = await buildReportPage(fakeContext([row("about", "en"), row("contact", "en")]), STATE, DEFAULT_SETTINGS, "en");
		expect(sections(blocks).map((section) => section.text)).toEqual(["about · Pages", "contact · Pages"]);
	});
});

describe("filters and paging", () => {
	const filtered: ReportView = { collection: "pages", rank: 1, cursor: null };

	it("keep the other filter when one changes", async () => {
		const { blocks } = await buildReportPage(fakeContext([row("about", "en")]), STATE, DEFAULT_SETTINGS, "en", filtered);
		const [collection, priority] = selects(blocks);
		const posts = collection?.options.find((option) => option.label === "Posts");
		expect(viewFrom(posts?.value)).toEqual({ collection: "posts", rank: 1, cursor: null });
		const urgent = priority?.options.find((option) => option.label === "Urgent");
		expect(viewFrom(urgent?.value)).toEqual({ collection: "pages", rank: 0, cursor: null });
		// The select shows the filter in force.
		expect(viewFrom(collection?.initial_value)).toEqual(filtered);
	});

	it("page within the filters", async () => {
		const { blocks } = await buildReportPage(fakeContext([row("about", "en")], true), STATE, DEFAULT_SETTINGS, "en", filtered);
		const next = buttons(blocks).find((button) => button.action_id === VIEW_ACTION);
		expect(viewFrom(next?.value)).toEqual({ ...filtered, cursor: "next-page" });
	});

	it("fall back to all collections when the filtered one is gone", async () => {
		// The host rejects a select whose initial value matches no option.
		const gone: ReportView = { collection: "events", rank: null, cursor: "stale" };
		const { blocks } = await buildReportPage(fakeContext([row("about", "en")]), STATE, DEFAULT_SETTINGS, "en", gone);
		expect(validateBlocks(blocks).valid).toBe(true);
		expect(viewFrom(selects(blocks)[0]?.initial_value)).toEqual({ collection: null, rank: null, cursor: null });
		expect(sections(blocks)).toHaveLength(1);
	});

	it("read a view it did not write as the first page", () => {
		expect(viewFrom("not json")).toEqual({ collection: null, rank: null, cursor: null });
		expect(viewFrom({ collection: 5, rank: 9, cursor: "" })).toEqual({ collection: null, rank: null, cursor: null });
	});
});

describe("the settings form", () => {
	it("shows the saved values, not blank fields", () => {
		// Block Kit inputs render `initial_value`; anything else leaves the field empty.
		const { blocks } = buildSettingsPage({ ...DEFAULT_SETTINGS, staleMonths: 18, reportMissingDescriptions: false }, "en");
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
