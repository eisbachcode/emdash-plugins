import type { Block, ButtonElement, SectionBlock } from "@emdash-cms/blocks";
import { validateBlocks } from "@emdash-cms/blocks/server";
import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { PANEL_ID, renderPanel, SET_ASIDE_ACTION, UNDO_ACTION } from "../src/panel.js";
import { finding, newHost, runSweep, undescribed } from "./host.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

const sections = (blocks: Block[]) => blocks.filter((block): block is SectionBlock => block.type === "section");
const button = (section: SectionBlock | undefined) => section?.accessory as ButtonElement | undefined;

describe("the Freshness panel", () => {
	it("shows the entry's findings and records them", async () => {
		host = await newHost();
		const entry = await undescribed(host, "posts", "panel-shows");

		const response = await host.admin.loadEditorPanel(PANEL_ID, "posts", entry.id);

		expect(validateBlocks(response.blocks).valid).toBe(true);
		const [section] = sections(response.blocks);
		expect(section?.text).toContain("SEO description");
		expect(button(section)).toMatchObject({ action_id: SET_ASIDE_ACTION, label: "Ignore" });
		// Opening the panel is a check: the report has the finding before any sweep.
		expect(await finding(host, "posts", entry.id)).not.toBeNull();
	});

	it("sets a finding aside so that neither the report nor a sweep brings it back, and undoes it", async () => {
		host = await newHost();
		const entry = await undescribed(host, "posts", "panel-ignores");
		await host.admin.loadEditorPanel(PANEL_ID, "posts", entry.id);

		const ignored = await host.admin.actEditorPanel(PANEL_ID, "posts", entry.id, SET_ASIDE_ACTION, {
			value: { rule: "missing-description" },
		});
		expect(validateBlocks(ignored.blocks).valid).toBe(true);
		expect(button(sections(ignored.blocks)[0])).toMatchObject({ action_id: UNDO_ACTION });
		expect(await finding(host, "posts", entry.id)).toBeNull();

		await runSweep(host);
		expect(await finding(host, "posts", entry.id)).toBeNull();

		await host.admin.actEditorPanel(PANEL_ID, "posts", entry.id, UNDO_ACTION, { value: { rule: "missing-description" } });
		expect(await finding(host, "posts", entry.id)).not.toBeNull();
	});

	it("opens for an author on their own entry", async () => {
		// The report needs plugins:read (editor). The panel is where an author
		// sees and sets aside the findings on their own entries.
		host = await newHost();
		const author = await host.fixtures.user({ email: "author@example.test", role: "author" });
		const entry = await host.fixtures.content("posts", {
			slug: "authors-own",
			data: {},
			status: "published",
			authorId: author.id,
		});

		const response = await host.admin.loadEditorPanel(PANEL_ID, "posts", entry.id, { user: author });

		expect(sections(response.blocks)[0]?.text).toContain("SEO description");
	});
});

describe("the panel's controls", () => {
	it("offer no way to set aside a missed schedule", () => {
		const { blocks } = renderPanel("en", {
			active: [{ rule: "overdue-schedule", severity: "high", params: { date: "2026-09-01", kind: "publish", status: "draft" } }],
			setAside: [],
		});
		expect(sections(blocks)[0]?.accessory).toBeUndefined();
	});

	it("offer a review, not an ignore, for a stale entry", () => {
		const { blocks } = renderPanel("en", {
			active: [{ rule: "stale", severity: "medium", params: { since: "2025-01-01" } }],
			setAside: [],
		});
		expect(button(sections(blocks)[0])?.label).toBe("Mark as reviewed");
	});
});
