import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { INDEX_VERSION } from "../src/index/bootstrap.js";
import { GRAPHQL_ENDPOINT, RUM_DATASET } from "../src/providers/cloudflare.js";
import type { SyncState } from "../src/sync/scheduler.js";
import { utcDay } from "../src/sync/window.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

const OVERVIEW = { data: { viewer: { accounts: [{ totals: [], series: [], pages: [], refs: [], geo: [] }] } } };
const PATHS = { data: { viewer: { accounts: [{ [RUM_DATASET]: [] }] } } };

async function tick(runtime: PluginRuntimeTestHost, name = "sync") {
	await runtime.transport.invokeHook("cron", { name, scheduledAt: new Date().toISOString() });
	return await runtime.inspect.kv.get<SyncState>("state");
}

describe("a failed tick", () => {
	it("stays visible through a Refresh until the phase that failed succeeds", async () => {
		// A Refresh runs an overview out of turn; clearing a paths error there
		// would hide it until the next paths tick fails again.
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
		host = await createPluginRuntimeTestHost({
			site: { url: "https://example.test", locale: "en", trailingSlash: "always" },
		});
		await host.actions.plugin.updateSettings({ cfApiToken: "cfat_test", cfAccountId: "acct-1", cfSiteTag: "tag-1" });
		await host.fixtures.plugin.storage("entries", "/about/", {
			path: "/about/",
			collection: "pages",
			entryId: "e1",
			translationGroup: "e1",
			locale: "en",
			title: "About",
			status: "published",
			views7: 0,
			views30: 0,
			updatedAt: new Date().toISOString(),
		});
		await host.fixtures.plugin.kv("state", {
			phase: "paths",
			provider: "cloudflare",
			backfilled: true,
			indexComplete: true,
			indexVersion: INDEX_VERSION,
			older: { day: utcDay(new Date()), complete: true },
			lastSync: new Date().toISOString(),
		});

		await host.http.respond(GRAPHQL_ENDPOINT, new Response("upstream down", { status: 502 }));
		await host.http.respond(GRAPHQL_ENDPOINT, json(OVERVIEW));
		await host.http.respond(GRAPHQL_ENDPOINT, json(PATHS));

		const failed = await tick(host);
		expect(failed?.lastProblem?.key).toBe("cfHttp");

		const afterRefresh = await tick(host, "refresh");
		expect(afterRefresh?.phase).toBe("paths");
		expect(afterRefresh?.lastProblem?.key).toBe("cfHttp");

		const afterPaths = await tick(host);
		expect(afterPaths?.lastError).toBeUndefined();
	});
});
