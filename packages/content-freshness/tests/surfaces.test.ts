import { validateBlocks } from "@emdash-cms/blocks/server";
import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { AUDIT_NOW_ACTION, SAVE_SETTINGS_ACTION } from "../src/report.js";
import { PANEL_ID } from "../src/panel.js";
import { SETTINGS_KEY } from "../src/settings.js";
import { failNextCall } from "./bridge-calls.js";
import { finding, newHost, runSweep, undescribed } from "./host.js";

/**
 * The host rejects a sandboxed response whose blocks do not validate with a
 * 502, which is what the report, the widget and the settings form all did
 * before their blocks were typed: `stats` needs `items`, a table needs
 * `page_action_id`, a form needs `fields` and `submit`.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

const valid = (response: { blocks: unknown[] }) => validateBlocks(response.blocks as never).valid;

async function auditTask(runtime: PluginRuntimeTestHost) {
	return (await runtime.inspect.scheduledTasks()).find((task) => task.name === "audit");
}

describe("every admin surface validates", () => {
	it("before the first audit", async () => {
		host = await newHost();
		expect(valid(await host.admin.loadWidget("summary"))).toBe(true);
		expect(valid(await host.admin.loadPage("/report"))).toBe(true);
		expect(valid(await host.admin.loadPage("/settings"))).toBe(true);
	});

	it("with findings to show", async () => {
		host = await newHost();
		await undescribed(host, "posts", "no-description");
		await runSweep(host);
		expect(valid(await host.admin.loadWidget("summary"))).toBe(true);
		expect(valid(await host.admin.loadPage("/report"))).toBe(true);
		expect(valid(await host.admin.act("/report", AUDIT_NOW_ACTION))).toBe(true);
	});
});

describe("the recurring audit", () => {
	it("is scheduled the first time the admin shows the plugin, without an activate event", async () => {
		// A plugin listed in astro.config.mjs is active from the start and
		// never receives plugin:activate.
		host = await newHost();
		expect(await auditTask(host)).toBeUndefined();

		await host.admin.loadWidget("summary");

		expect(await auditTask(host)).toMatchObject({ schedule: "0 4 * * *" });
	});

	it("keeps its schedule when the settings name one the scheduler rejects", async () => {
		host = await newHost();
		await host.admin.loadPage("/settings");

		const response = await host.admin.submit("/settings", SAVE_SETTINGS_ACTION, { schedule: "every night at four" });

		expect(response.toast?.type).toBe("error");
		expect(response.toast?.message).toContain("every night at four");
		expect(await host.inspect.kv.get(SETTINGS_KEY)).toMatchObject({ schedule: "0 4 * * *" });
		expect(await auditTask(host)).toMatchObject({ schedule: "0 4 * * *" });
	});

	it("is registered again on activation even when the settings say it already runs", async () => {
		// An uninstall that keeps the data deletes the plugin's cron tasks but
		// not its KV, so on reinstall the record says "scheduled" and is wrong.
		host = await newHost();
		await host.fixtures.plugin.kv(SETTINGS_KEY, { scheduledAs: "0 4 * * *" });

		await host.actions.plugin.activate();

		expect(await auditTask(host)).toMatchObject({ schedule: "0 4 * * *" });
	});

	it("does not take the dashboard down when scheduling fails", async () => {
		host = await newHost();
		failNextCall("cronSchedule");

		expect(valid(await host.admin.loadWidget("summary"))).toBe(true);
		expect(await auditTask(host)).toBeUndefined();

		await host.admin.loadWidget("summary");
		expect(await auditTask(host)).toMatchObject({ schedule: "0 4 * * *" });
	});

	it("moves to a new schedule that the scheduler accepts", async () => {
		host = await newHost();
		const response = await host.admin.submit("/settings", SAVE_SETTINGS_ACTION, { schedule: "30 2 * * *" });

		expect(response.toast?.type).toBe("success");
		expect(await auditTask(host)).toMatchObject({ schedule: "30 2 * * *" });
	});
});

describe("the report's paging", () => {
	it("falls back to the first page for a cursor storage cannot read", async () => {
		host = await newHost();
		await undescribed(host, "posts", "no-description");
		await runSweep(host);

		const response = await host.admin.act("/report", "report_view", { value: { cursor: "not-a-cursor" } });

		expect(valid(response)).toBe(true);
		expect(JSON.stringify(response.blocks)).toContain("no-description");
	});
});

describe("a collection left out of the audit", () => {
	it("loses its findings with the next sweep, and its entries' panel says why", async () => {
		host = await newHost();
		const entry = await undescribed(host, "posts", "left-out");
		await runSweep(host);
		expect(await finding(host, "posts", entry.id)).not.toBeNull();

		const saved = await host.admin.submit("/settings", SAVE_SETTINGS_ACTION, { "collection:posts:skip": true });
		expect(saved.toast?.type).toBe("success");
		await runSweep(host);

		expect(await finding(host, "posts", entry.id)).toBeNull();
		const panel = await host.admin.loadEditorPanel(PANEL_ID, "posts", entry.id);
		expect(JSON.stringify(panel.blocks)).toContain("left out of the freshness audit");
	});

	it("shows the collection's own settings in the form", async () => {
		host = await newHost();
		await host.admin.submit("/settings", SAVE_SETTINGS_ACTION, { "collection:posts:staleMonths": 0 });

		const page = await host.admin.loadPage("/settings");

		expect(valid(page)).toBe(true);
		const form = page.blocks.find((block) => block.type === "form") as { fields: Array<{ action_id: string; initial_value?: unknown }> };
		expect(form.fields.find((field) => field.action_id === "collection:posts:staleMonths")?.initial_value).toBe(0);
	});
});
