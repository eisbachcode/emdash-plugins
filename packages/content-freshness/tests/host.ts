import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

import type { EntryFindings } from "../src/findings.js";

/**
 * Hosts for tests that run the plugin sandboxed in workerd.
 *
 * Two properties of this harness shape the tests:
 *
 * - `actions.content.*` fire the plugin's hooks deferred through `after()`,
 *   and nothing awaits them. Hooks are therefore driven with
 *   `transport.invokeHook()`, and the one test of the real pipeline waits
 *   for its effect.
 * - Plugin storage outlives `dispose()` within a test file, so assertions
 *   name the rows they are about instead of counting the collection.
 */

/** A host with one SEO-enabled collection, so a published entry without a description has a finding. */
export async function newHost(slug = "posts"): Promise<PluginRuntimeTestHost> {
	const host = await createPluginRuntimeTestHost();
	await host.fixtures.collection({ slug, label: slug, hasSeo: true, routable: true, urlPattern: `/${slug}/{slug}` });
	return host;
}

/** A published entry with no SEO description: one medium finding. */
export async function undescribed(host: PluginRuntimeTestHost, collection: string, slug: string) {
	return host.fixtures.content(collection, { slug, data: {}, status: "published" });
}

/**
 * Start an audit and run the real cron executor until nothing is due.
 *
 * Follow-ups are scheduled from the wall clock, so the host's scheduler
 * clock is moved a day past it; every one-shot is then due at once.
 */
export async function runSweep(host: PluginRuntimeTestHost): Promise<void> {
	host.scheduled.setTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
	await host.transport.invokeHook("cron", { name: "audit-now" });
	for (let runs = 0; runs < 50; runs++) {
		if ((await host.scheduled.run()).processed === 0) return;
	}
	throw new Error("the sweep did not finish in 50 runs");
}

export async function finding(host: PluginRuntimeTestHost, collection: string, entryId: string) {
	return host.inspect.storage.get<EntryFindings>("findings", `${collection}:${entryId}`);
}
