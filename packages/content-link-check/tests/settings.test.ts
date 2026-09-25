import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, mergeSettings, readSettings } from "../src/settings.js";

describe("readSettings", () => {
	it("returns defaults on an empty store", async () => {
		expect(await readSettings(fakeKv({}))).toEqual(DEFAULT_SETTINGS);
	});

	it("reads stored values", async () => {
		const settings = await readSettings(fakeKv({ settings: { batchSize: 10, checkExternal: false } }));
		expect(settings).toMatchObject({
			batchSize: 10,
			checkExternal: false,
			schedule: DEFAULT_SETTINGS.schedule,
		});
	});
});

describe("mergeSettings", () => {
	it("clamps on the way in and ignores unknown keys", () => {
		const merged = mergeSettings(DEFAULT_SETTINGS, { batchSize: 9999, nonsense: true });
		expect(merged.batchSize).toBe(100);
		expect(merged).not.toHaveProperty("nonsense");
	});

	it("keeps what the form did not send", () => {
		const current = { ...DEFAULT_SETTINGS, schedule: "0 5 * * *" };
		expect(mergeSettings(current, { checkExternal: false })).toMatchObject({
			schedule: "0 5 * * *",
			checkExternal: false,
		});
	});
});

function fakeKv(store: Record<string, unknown>) {
	return {
		kv: {
			get: async (key: string) => store[key] ?? null,
			list: async () => Object.entries(store).map(([key, value]) => ({ key, value })),
		},
	} as unknown as import("emdash/plugin").PluginContext;
}
