import { describe, expect, it } from "vitest";

import plugin from "../src/plugin.js";

/**
 * Surface test. The build probes the default export for its hook and
 * route keys, so a rename the manifest does not know about is a silent
 * behaviour loss — this catches it.
 */
describe("plugin surface", () => {
	it("registers the audit hooks", () => {
		expect(Object.keys(plugin.hooks ?? {}).sort()).toEqual(["cron", "plugin:activate"]);
	});

	it("registers the admin and status routes", () => {
		expect(Object.keys(plugin.routes ?? {}).sort()).toEqual(["admin", "status"]);
	});
});
