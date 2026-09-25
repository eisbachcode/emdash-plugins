import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GRAPHQL_ENDPOINT } from "../src/providers/cloudflare.js";
import { addDays, utcDay } from "../src/sync/window.js";

/**
 * The Cloudflare adapter through the production bridge, against faked
 * GraphQL responses. In its own file because plugin state outlives
 * `dispose()` within a file, and this test is about the very first tick.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

const EMPTY_OVERVIEW = { data: { viewer: { accounts: [{ totals: [], series: [], pages: [], refs: [], geo: [] }] } } };

function graphqlReply() {
	return new Response(JSON.stringify(EMPTY_OVERVIEW), { headers: { "Content-Type": "application/json" } });
}

function sentSince(index: number): unknown {
	const request = host!.http.requests()[index];
	if (!request) return undefined;
	const body = JSON.parse(new TextDecoder().decode(request.body)) as { variables: { since?: string } };
	return body.variables.since;
}

describe("the first sync", () => {
	it("reaches back to the edge of the exact window once, then re-reads the widget's week", async () => {
		// A fresh install used to show two days of history. Seven is as far
		// back as Cloudflare stays exact, and no further.
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
		host = await createPluginRuntimeTestHost({
			site: { url: "https://example.test", locale: "en", trailingSlash: "always" },
		});
		const saved = await host.actions.plugin.updateSettings({
			cfApiToken: "cfat_test",
			cfAccountId: "acct-1",
			cfSiteTag: "tag-1",
		});
		expect(saved).toMatchObject({ success: true });
		const today = utcDay(new Date());

		// Tick 1: overview with backfill. Tick 2: indexing, no request.
		// Tick 3: overview again, now over the regular window.
		await host.http.respond(GRAPHQL_ENDPOINT, graphqlReply());
		await host.http.respond(GRAPHQL_ENDPOINT, graphqlReply());
		for (let i = 0; i < 3; i++) {
			await host.transport.invokeHook("cron", { name: "sync", scheduledAt: new Date().toISOString() });
		}

		expect(sentSince(0)).toBe(addDays(today, -7));
		expect(sentSince(1)).toBe(addDays(today, -6));
	});
});
