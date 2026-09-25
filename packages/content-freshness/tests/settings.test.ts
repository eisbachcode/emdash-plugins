import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, readSettings, writeSettings } from "../src/settings.js";

describe("readSettings", () => {
	it("returns defaults on an empty store", async () => {
		expect(await readSettings(fakeKv({}))).toEqual(DEFAULT_SETTINGS);
	});

	it("orders the description bounds even if they are stored the wrong way round", async () => {
		const settings = await readSettings(
			fakeKv({ "settings:descriptionMin": 200, "settings:descriptionMax": 40 }),
		);
		expect([settings.descriptionMin, settings.descriptionMax]).toEqual([40, 200]);
	});
});

describe("writeSettings", () => {
	it("clamps numbers and ignores unknown keys", async () => {
		const store: Record<string, unknown> = {};
		await writeSettings(fakeKv(store), { staleMonths: 9999, nonsense: true });
		expect(store["settings:staleMonths"]).toBe(120);
		expect(store).not.toHaveProperty("nonsense");
	});
});

function fakeKv(store: Record<string, unknown>) {
	return {
		kv: {
			get: async (key: string) => store[key] ?? null,
			set: async (key: string, value: unknown) => {
				store[key] = value;
			},
			delete: async (key: string) => delete store[key],
			list: async () => [],
		},
	} as unknown as import("emdash/plugin").PluginContext;
}
