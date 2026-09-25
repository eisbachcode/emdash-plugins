import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The analytics page through the real sandbox, fed by the demo provider.
 * Plugin storage outlives `dispose()` within a file; these tests only read
 * what the first refresh of each host wrote.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function demoHostWithData() {
	const runtime = await createPluginRuntimeTestHost({
		site: { url: "https://example.test", locale: "en", trailingSlash: "always" },
	});
	await runtime.fixtures.plugin.setting("provider", "demo");
	await runtime.admin.act("widget:traffic", "analytics:refresh");
	runtime.scheduled.setTime(new Date());
	await runtime.scheduled.run();
	return runtime;
}

function chartLengths(response: { blocks: unknown[] }): number[] {
	const chart = response.blocks.find((b) => (b as { type: string }).type === "chart") as
		| { config: { series: Array<{ data: unknown[] }> } }
		| undefined;
	return chart ? chart.config.series.map((s) => s.data.length) : [];
}

describe("the analytics page", () => {
	it("is declared, so the admin lists it in the sidebar", async () => {
		host = await createPluginRuntimeTestHost();
		const manifest = host.manifest as unknown as { admin?: { pages?: Array<{ path: string; label: string }> } };
		expect(manifest.admin?.pages).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/analytics" })]));
	});

	it("charts 30 days by default and 90 after the range changes", async () => {
		host = await demoHostWithData();

		const first = await host.admin.loadPage("/analytics");
		const pages = (host.manifest.admin?.pages ?? []).map((page) => page.path);
		expect(validateBlockResponse(first, { pluginPagePaths: pages }).valid).toBe(true);
		expect(chartLengths(first)).toEqual([30, 30]);

		const wider = await host.admin.act("/analytics", "analytics:range", { value: 90 });
		expect(chartLengths(wider)).toEqual([90, 90]);
	});

	it("keeps the range across a refresh, which is the only place Block Kit can keep it", async () => {
		host = await demoHostWithData();
		const refreshed = await host.admin.act("/analytics", "analytics:page:refresh", { value: 7 });
		expect(chartLengths(refreshed)).toEqual([7, 7]);
		expect(refreshed.toast).toMatchObject({ type: "success" });
	});

	it("opens for an editor, not only for an admin", async () => {
		host = await demoHostWithData();
		const editor = await host.fixtures.user({ email: "editor@example.test", role: "editor" });
		const response = await host.admin.loadPage("/analytics", { user: editor });
		expect(chartLengths(response)).toEqual([30, 30]);
	});
});
