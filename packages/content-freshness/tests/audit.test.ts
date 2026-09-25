import type { PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { STATE_KEY, SWEEP_VERSION, type State } from "../src/state.js";
import { failNextCall } from "./bridge-calls.js";
import { finding, newHost, runSweep, undescribed } from "./host.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

describe("a sweep", () => {
	it("stores one row for an entry with findings, keyed by collection and entry", async () => {
		host = await newHost();
		const entry = await undescribed(host, "posts", "no-description");
		await runSweep(host);

		expect(await finding(host, "posts", entry.id)).toMatchObject({
			slug: "no-description",
			rank: 1,
			hits: [{ rule: "missing-description", severity: "medium" }],
		});
	});

	it("removes the rows of entries it no longer finds", async () => {
		host = await newHost();
		const kept = await undescribed(host, "posts", "kept");
		// A row left from an earlier sweep, for an entry deleted since.
		await host.fixtures.plugin.storage("findings", "posts:01GONE", {
			collection: "posts",
			entryId: "01GONE",
			slug: "gone",
			locale: "en",
			rank: 1,
			hits: [{ rule: "missing-description", severity: "medium", params: {} }],
			entryUpdatedAt: "2026-01-01T00:00:00.000Z",
			seenIn: "2026-01-01T00:00:00.000Z",
		});

		await runSweep(host);

		expect(await finding(host, "posts", "01GONE")).toBeNull();
		expect(await finding(host, "posts", kept.id)).not.toBeNull();
	});

	it("does not keep a trashed entry's row", async () => {
		host = await newHost();
		const entry = await undescribed(host, "posts", "trashed");
		await host.actions.content.trash("posts", entry.id);
		// The trash action's own hook runs deferred; let it finish, then put
		// the row back as an earlier sweep would have left it.
		await vi.waitFor(async () => expect(await finding(host!, "posts", entry.id)).toBeNull());
		await host.fixtures.plugin.storage("findings", `posts:${entry.id}`, {
			collection: "posts",
			entryId: entry.id,
			slug: "trashed",
			locale: "en",
			rank: 1,
			hits: [{ rule: "missing-description", severity: "medium", params: {} }],
			entryUpdatedAt: entry.updatedAt,
			seenIn: "2026-01-01T00:00:00.000Z",
		});

		await runSweep(host);

		expect(await finding(host, "posts", entry.id)).toBeNull();
	});
});

describe("a sweep that cannot list a collection", () => {
	it("keeps that collection's findings when the collection still exists", async () => {
		host = await newHost();
		const entry = await undescribed(host, "posts", "kept-on-error");
		await runSweep(host);

		failNextCall("contentList");
		host.scheduled.setTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
		await host.transport.invokeHook("cron", { name: "audit-now" }).catch(() => undefined);
		while ((await host.scheduled.run()).processed > 0);

		expect(await finding(host, "posts", entry.id)).not.toBeNull();
	});

	it("skips a collection deleted since the sweep started, and its rows go", async () => {
		host = await newHost();
		await host.fixtures.plugin.storage("findings", "gone:01GONE", {
			collection: "gone",
			entryId: "01GONE",
			slug: "gone",
			locale: "en",
			rank: 1,
			hits: [{ rule: "missing-description", severity: "medium", params: {} }],
			entryUpdatedAt: "2026-01-01T00:00:00.000Z",
			seenIn: "2026-01-01T00:00:00.000Z",
		});
		const sweep = {
			version: SWEEP_VERSION,
			startedAt: new Date().toISOString(),
			collections: ["gone", "posts"],
			index: 0,
			cursor: null,
			phase: "audit",
			info: {},
		};
		await host.fixtures.plugin.kv(STATE_KEY, { sweep, lastFinishedAt: null });

		host.scheduled.setTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
		await host.transport.invokeHook("cron", { name: "audit-next-a", data: { step: 1 } });
		while ((await host.scheduled.run()).processed > 0);

		expect(await finding(host, "gone", "01GONE")).toBeNull();
		expect(await host.inspect.kv.get(STATE_KEY)).toMatchObject({ sweep: null });
	});
});

describe("a sweep started by an earlier version of the plugin", () => {
	it("starts over instead of auditing with information it lacks", async () => {
		host = await newHost();
		const entry = await undescribed(host, "posts", "after-upgrade");
		const old = { startedAt: new Date().toISOString(), collections: ["posts"], index: 0, cursor: null, phase: "audit" };
		await host.fixtures.plugin.kv(STATE_KEY, { sweep: old, lastFinishedAt: null });

		host.scheduled.setTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
		await host.transport.invokeHook("cron", { name: "audit-next-a", data: { step: 1 } });
		const state = await host.inspect.kv.get<State>(STATE_KEY);

		expect(state?.sweep?.version ?? SWEEP_VERSION).toBe(SWEEP_VERSION);
		while ((await host.scheduled.run()).processed > 0);
		expect(await finding(host, "posts", entry.id)).not.toBeNull();
	});
});

describe("content hooks", () => {
	it("drop an entry's row when it is deleted", async () => {
		host = await newHost();
		const entry = await undescribed(host, "posts", "to-delete");
		await runSweep(host);
		expect(await finding(host, "posts", entry.id)).not.toBeNull();

		await host.transport.invokeHook("content:afterDelete", { id: entry.id, collection: "posts", permanent: true });

		expect(await finding(host, "posts", entry.id)).toBeNull();
	});

	it("re-check an entry when its state changes", async () => {
		host = await newHost();
		const entry = await undescribed(host, "posts", "to-unpublish");
		await runSweep(host);
		expect(await finding(host, "posts", entry.id)).not.toBeNull();

		// Through EmDash's own pipeline: SEO is not judged on a draft, so the
		// finding goes away once the unpublish hook has re-checked the entry.
		await host.actions.content.unpublish("posts", entry.id);
		await vi.waitFor(async () => expect(await finding(host!, "posts", entry.id)).toBeNull());
	});

	it("record a finding as soon as an entry is published", async () => {
		host = await newHost();
		const entry = await host.fixtures.content("posts", { slug: "fresh-draft", data: {} });
		expect(await finding(host, "posts", entry.id)).toBeNull();

		await host.actions.content.publish("posts", entry.id);
		await vi.waitFor(async () =>
			expect(await finding(host!, "posts", entry.id)).toMatchObject({ hits: [{ rule: "missing-description" }] }),
		);
	});
});
