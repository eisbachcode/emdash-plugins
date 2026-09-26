import { ROLE } from "@eisbachcode/emdash-plugin-shared";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SweepState } from "../src/state.js";
import { bridgeCalls, bridgeCallsWithSizes } from "./bridge-calls.js";

/**
 * The platform's limits, as of emdash 0.40 on Cloudflare. They are what the
 * plugin must stay under, so they are written out here rather than taken
 * from the plugin's own constants.
 */
/** Bridge calls a sandboxed invocation may make. */
const SANDBOX_CALLS = 10;
/** Ids one storage call may bind: D1 allows 100 parameters and emdash's plugin storage adds two. */
const D1_IDS = 98;
/**
 * D1 queries a run may make in-process on Workers Free: 50 per invocation,
 * less what emdash's cron runner spends claiming and finishing the task.
 */
const D1_QUERIES = 40;
/** Outbound subrequests an in-process invocation may make on Workers Free. */
const OUTBOUND = 50;
/** emdash resolves each request's host over DNS-over-HTTPS (A and AAAA) before making it. */
const SUBREQUESTS_PER_REQUEST = 3;
/** D1 queries of each bridge call, from emdash's implementation; `putMany` is one per row. */
const QUERIES_OF: Record<string, number> = { contentList: 3, cronSchedule: 2, schemaListCollections: 2 };

/**
 * Every invocation against the bridge-call budget.
 *
 * A sandboxed invocation that makes one call too many is aborted on
 * Cloudflare, and the local harness enforces no limit, so these count the
 * calls. The sweep tests measure every run of whole sweeps rather than one
 * hand-picked run per phase, and check the sweep finished, so a fixture
 * too small to reach a phase's worst case cannot pass quietly.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

const ENTRIES = 30;
const FIXTURE_HEAVY_MS = 60_000;
const admin = { id: "u1", email: "admin@example.test", name: null, role: ROLE.ADMIN, createdAt: "2026-01-01" };

function night(daysAhead: number, time: string): string {
	const day = new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
	return `${day}T${time}.000Z`;
}

/**
 * Answers for one night of checks. Each entry links to its own internal
 * page, an outbound page whose HEAD is refused (so the check spends a GET
 * too), an outbound page that redirects once and one that redirects five
 * times. One shared host rate-limits.
 */
async function answerOneNight(runtime: PluginRuntimeTestHost): Promise<void> {
	for (let i = 0; i < ENTRIES; i++) {
		await runtime.http.respond(`https://example.test/page-${i}`, new Response(null, { status: 200 }));
		await runtime.http.respond(`https://guarded${i}.test/`, new Response(null, { status: 403 }));
		await runtime.http.respond(`https://guarded${i}.test/`, new Response(null, { status: 200 }));
		await runtime.http.respond(
			`https://moved${i}.test/`,
			new Response(null, { status: 301, headers: { location: `https://landed${i}.test/` } }),
		);
		await runtime.http.respond(`https://landed${i}.test/`, new Response(null, { status: 200 }));
		// Five redirects, as many as emdash follows.
		for (let hop = 1; hop <= 5; hop++) {
			await runtime.http.respond(
				`https://chain${i}.test/${hop}`,
				new Response(null, { status: 302, headers: { location: `/${hop + 1}` } }),
			);
		}
		await runtime.http.respond(`https://chain${i}.test/6`, new Response(null, { status: 200 }));
	}
	await runtime.http.respond(
		"https://busy.test/a",
		new Response(null, { status: 429, headers: { "retry-after": String(7 * 86_400) } }),
	);
	await runtime.http.respond(
		"https://busy.test/b",
		new Response(null, { status: 429, headers: { "retry-after": String(7 * 86_400) } }),
	);
}

async function site(): Promise<{ runtime: PluginRuntimeTestHost; ids: string[] }> {
	const runtime = await createPluginRuntimeTestHost();
	await runtime.fixtures.site({ url: "https://example.test" });
	await runtime.fixtures.collection({
		slug: "posts",
		label: "Posts",
		fields: ["cta_url", "guarded_url", "moved_url", "chain_url", "busy_url"].map((slug) => ({
			slug,
			label: slug,
			type: "string" as const,
		})),
	});
	const ids: string[] = [];
	for (let i = 0; i < ENTRIES; i++) {
		const entry = await runtime.fixtures.content("posts", {
			slug: `post-${i}`,
			status: "published",
			data: {
				cta_url: `/page-${i}`,
				guarded_url: `https://guarded${i}.test/`,
				moved_url: `https://moved${i}.test/`,
				chain_url: `https://chain${i}.test/1`,
				busy_url: i % 2 === 0 ? "https://busy.test/a" : "https://busy.test/b",
			},
		});
		ids.push(entry.id);
	}
	return { runtime, ids };
}

interface Run {
	calls: Array<{ name: string; size: number }>;
	/** Requests the plugin's fetches made, every redirect hop included. */
	requests: number;
}

/** Run the cron executor until nothing is due, returning what every run did. */
async function sweepRuns(runtime: PluginRuntimeTestHost): Promise<Run[]> {
	const runs: Run[] = [];
	for (let i = 0; i < 600; i++) {
		let processed = 0;
		const before = runtime.http.requests().length;
		const calls = await bridgeCallsWithSizes(async () => {
			processed = (await runtime.scheduled.run()).processed;
		});
		if (processed === 0) return runs;
		runs.push({ calls, requests: runtime.http.requests().length - before });
	}
	throw new Error("the sweep did not end");
}

/** Every run that breaks one of the platform's limits, described. */
function over(runs: Run[]): string[] {
	return runs.flatMap(({ calls, requests }) => {
		const names = calls.map(({ name }) => name);
		const queries = calls.reduce(
			(sum, { name, size }) => sum + (name === "storagePutMany" ? size : (QUERIES_OF[name] ?? 1)),
			0,
		);
		const widestIn = Math.max(
			0,
			...calls.filter(({ name }) => name === "storageGetMany" || name === "storageDeleteMany").map(({ size }) => size),
		);
		const outbound = requests * SUBREQUESTS_PER_REQUEST;
		const broken = [
			names.length > SANDBOX_CALLS && `${names.length} bridge calls`,
			queries > D1_QUERIES && `${queries} D1 queries`,
			widestIn > D1_IDS && `${widestIn} ids in one call`,
			outbound > OUTBOUND && `${outbound} outbound subrequests`,
		].filter(Boolean);
		return broken.length > 0 ? [`${broken.join(", ")}: ${names.join(", ")}`] : [];
	});
}

describe("a sweep", () => {
	it(
		"never makes a run spend more than the budget, first sweep and a pruning one alike",
		async () => {
			const { runtime, ids } = await site();
			host = runtime;

			await answerOneNight(runtime);
			runtime.scheduled.setTime(night(1, "02:59:00"));
			await runtime.actions.plugin.activate();
			runtime.scheduled.setTime(night(1, "03:00:05"));
			const first = await sweepRuns(runtime);
			expect(over(first)).toEqual([]);
			expect((await runtime.inspect.kv.get<SweepState>("state"))?.phase).toBe("done");
			// Four links of each entry's own, and two busy.test links they share.
			expect(await runtime.inspect.storage.list("checks")).toHaveLength(ENTRIES * 4 + 2);

			// More than one delete's worth, so the prune's id cap is exercised.
			for (const id of ids.slice(0, 20)) await runtime.actions.content.unpublish("posts", id);
			await answerOneNight(runtime);
			runtime.scheduled.setTime(night(2, "03:00:05"));
			const second = await sweepRuns(runtime);
			expect(over(second)).toEqual([]);
			expect((await runtime.inspect.kv.get<SweepState>("state"))?.phase).toBe("done");
			expect(await runtime.inspect.storage.list("checks")).toHaveLength((ENTRIES - 20) * 4 + 2);
		},
		FIXTURE_HEAVY_MS,
	);
});

describe("the admin and the hooks", () => {
	/** A config install: never activated, so the first surface also has to register the sweep. */
	async function configInstall(): Promise<PluginRuntimeTestHost> {
		const runtime = await createPluginRuntimeTestHost();
		await runtime.fixtures.site({ url: "https://example.test" });
		await runtime.fixtures.collection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "cta_url", label: "cta", type: "string" }],
		});
		// One link in enough entries that the report has a long list of places to summarise.
		for (let i = 0; i < 250; i++) {
			await runtime.fixtures.content("posts", { slug: `post-${i}`, status: "published", data: { cta_url: "/old" } });
		}
		await runtime.http.respond(
			"https://example.test/old",
			new Response(null, { status: 301, headers: { location: "/new" } }),
		);
		return runtime;
	}

	function admin_(runtime: PluginRuntimeTestHost, body: Record<string, unknown>) {
		return () =>
			runtime.actions.routes.request("admin", {
				method: "POST",
				headers: { "x-emdash-request": "1" },
				body,
				user: admin,
			});
	}

	it(
		"stay within the budget on every surface, each at its worst",
		async () => {
			host = await configInstall();
			const surfaces = {
				widget: admin_(host, { type: "page_load", page: "widget:summary" }),
				report: admin_(host, { type: "page_load", page: "/report" }),
				settings: admin_(host, { type: "page_load", page: "/settings" }),
			};

			// Each surface first on a fresh isolate's worth of state: the sweep
			// is not registered yet, so the check has to schedule it too.
			const firstLoad = await bridgeCalls(surfaces.widget);
			expect(firstLoad, firstLoad.join(", ")).toContain("cronSchedule");
			expect(firstLoad.length, firstLoad.join(", ")).toBeLessThanOrEqual(SANDBOX_CALLS);

			const night1 = night(1, "03:00:05");
			host.scheduled.setTime(night1);
			await sweepRuns(host);

			for (const [name, load] of Object.entries(surfaces)) {
				const calls = await bridgeCalls(load);
				expect(calls.length, `${name}: ${calls.join(", ")}`).toBeLessThanOrEqual(SANDBOX_CALLS);
			}

			const save = await bridgeCalls(
				admin_(host, { type: "form_submit", action_id: "save_settings", values: { schedule: "0 4 * * *" } }),
			);
			expect(save.length, save.join(", ")).toBeLessThanOrEqual(SANDBOX_CALLS);

			const sweepNow = await bridgeCalls(admin_(host, { type: "block_action", action_id: "sweep_now" }));
			expect(sweepNow.length, sweepNow.join(", ")).toBeLessThanOrEqual(SANDBOX_CALLS);

			const status = await bridgeCalls(() => host!.actions.routes.request("status", { user: admin }));
			expect(status.length, status.join(", ")).toBeLessThanOrEqual(SANDBOX_CALLS);
		},
		FIXTURE_HEAVY_MS,
	);

	it("stay within the budget in a content hook that has to register the sweep", async () => {
		host = await createPluginRuntimeTestHost();
		await host.fixtures.site({ url: "https://example.test" });
		await host.fixtures.collection({ slug: "posts", label: "Posts" });
		const draft = await host.fixtures.content("posts", { slug: "post", status: "draft", data: {} });

		const calls = await bridgeCalls(async () => {
			await host!.actions.content.publish("posts", draft.id);
			// Content hooks run deferred, after the action has answered.
			await vi.waitFor(async () => expect(await host?.inspect.scheduledTasks()).not.toEqual([]));
		});
		expect(calls, calls.join(", ")).toContain("cronSchedule");
		expect(calls.length, calls.join(", ")).toBeLessThanOrEqual(SANDBOX_CALLS);
	});
});
