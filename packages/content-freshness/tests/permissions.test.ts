import { ROLE } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext } from "emdash/plugin";
import { describe, expect, it } from "vitest";

import plugin from "../src/plugin.js";

/**
 * The report exists for editors, so the route has to say so: an `admin`
 * route with no declared permission dispatches at `plugins:manage`, which is
 * administrators only, and every editor gets a permission error inside the
 * widget card instead of the report.
 *
 * One route carries one permission, and this one also serves the settings
 * form, so the form is held to administrators in the handler.
 */

function fakeContext() {
	const writes: Array<[string, unknown]> = [];
	const scheduled: string[] = [];
	const ctx = {
		kv: {
			async get() {
				return null;
			},
			async set(key: string, value: unknown) {
				writes.push([key, value]);
			},
		},
		cron: {
			async schedule(name: string) {
				scheduled.push(name);
			},
		},
		log: { debug() {}, info() {}, warn() {}, error() {} },
	} as unknown as PluginContext;
	return { ctx, writes, scheduled };
}

function adminHandler() {
	const route = plugin.routes?.admin;
	if (!route) throw new Error("plugin registers no admin route");
	return typeof route === "function" ? route : route.handler;
}

async function saveSettingsAs(role: number | undefined) {
	const { ctx, writes, scheduled } = fakeContext();
	const result = (await adminHandler()(
		{
			input: { type: "form_submit", action_id: "save_settings", values: { schedule: "0 5 * * *" } },
			request: { url: "https://example.test", method: "POST", headers: {} },
			...(role === undefined ? {} : { user: { id: "u1", email: "u@example.test", name: null, role } }),
		} as never,
		ctx,
	)) as { toast?: { message: string; type: string } };
	return { result, writes, scheduled };
}

describe("the admin route's permission", () => {
	it("declares plugins:read so editors can open it", () => {
		const route = plugin.routes?.admin;
		expect(typeof route === "object" && route.permission).toBe("plugins:read");
	});
});

describe("saving settings", () => {
	it("is refused for an editor, with a reason", async () => {
		const { result, writes, scheduled } = await saveSettingsAs(ROLE.EDITOR);
		expect(writes).toHaveLength(0);
		expect(scheduled).toHaveLength(0);
		expect(result.toast?.type).toBe("error");
		expect(result.toast?.message).toMatch(/administrator/i);
	});

	it("is refused when there is no user at all", async () => {
		const { result, writes } = await saveSettingsAs(undefined);
		expect(writes).toHaveLength(0);
		expect(result.toast?.type).toBe("error");
	});

	it("goes through for an administrator", async () => {
		const { result, writes, scheduled } = await saveSettingsAs(ROLE.ADMIN);
		expect(writes.length).toBeGreaterThan(0);
		// The cron is re-registered so a changed expression takes effect.
		expect(scheduled).toContain("audit");
		expect(result.toast).toBeUndefined();
	});
});
