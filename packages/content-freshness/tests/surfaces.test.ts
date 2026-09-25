import { validateBlocks } from "@emdash-cms/blocks/server";
import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { AUDIT_NOW_ACTION, SAVE_SETTINGS_ACTION } from "../src/report.js";
import { SETTINGS_KEY } from "../src/settings.js";
import { newHost, runSweep, undescribed } from "./host.js";

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
		expect(await host.inspect.kv.get(SETTINGS_KEY)).toBeNull();
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

		const response = await host.admin.act("/report", "findings_page", { value: { cursor: "not-a-cursor" } });

		expect(valid(response)).toBe(true);
		expect(JSON.stringify(response.blocks)).toContain("no-description");
	});
});
