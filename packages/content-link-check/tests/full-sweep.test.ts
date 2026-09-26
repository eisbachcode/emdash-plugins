import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { ROLE } from "@eisbachcode/emdash-plugin-shared";

import type { SweepState } from "../src/state.js";
import type { CheckRow } from "../src/store.js";

/**
 * One scheduled run does one bounded slice of work: plan a page of entries,
 * or check a batch of them. A nightly schedule that ran one slice per night
 * would take weeks to get through a site of any size, so a run that made
 * progress has to hand over to a follow-up run.
 *
 * This goes through the real runtime and cron executor, because the trap is
 * there: the executor deletes a finished one-shot task by id, so a follow-up
 * scheduled under the running task's own name is silently thrown away.
 */

const ENTRIES = 60;
/** Creating a few hundred entries outlasts vitest's default five seconds on a busy machine. */
const FIXTURE_HEAVY_MS = 30_000;
let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

/**
 * A time on the test clock, `daysAhead` days from today. Follow-up runs are
 * timed by the plugin's clock, which is the real one, while the executor
 * runs on the test clock, so a night has to lie ahead of the real clock or
 * no follow-up is ever due.
 */
function night(daysAhead: number, time: string): string {
	const day = new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
	return `${day}T${time}.000Z`;
}

/** Run the cron executor until nothing is due, as successive Cron Trigger firings would. */
async function drain(runtime: PluginRuntimeTestHost, limit: number): Promise<number> {
	let runs = 0;
	for (; runs < limit; runs++) {
		const { processed } = await runtime.scheduled.run();
		if (processed === 0) break;
	}
	return runs;
}

/** A site with one collection whose string fields are the given link fields. */
async function site(fields: string[]): Promise<PluginRuntimeTestHost> {
	const runtime = await createPluginRuntimeTestHost();
	await runtime.fixtures.site({ url: "https://example.test" });
	await runtime.fixtures.collection({
		slug: "posts",
		label: "Posts",
		fields: fields.map((slug) => ({ slug, label: slug, type: "string" as const })),
	});
	return runtime;
}

function post(runtime: PluginRuntimeTestHost, slug: string, data: Record<string, unknown>, status = "published") {
	return runtime.fixtures.content("posts", { slug, data, status });
}

/** More runs than any sweep in this file needs, so a chain that never ends shows as reaching it. */
const MAX_RUNS = 200;

/** Activate the plugin and run the first nightly sweep to its end. */
async function firstNight(runtime: PluginRuntimeTestHost): Promise<number> {
	runtime.scheduled.setTime(night(1, "02:59:00"));
	await runtime.actions.plugin.activate();
	runtime.scheduled.setTime(night(1, "03:00:05"));
	return drain(runtime, MAX_RUNS);
}

async function nextNight(runtime: PluginRuntimeTestHost, daysAhead: number): Promise<void> {
	runtime.scheduled.setTime(night(daysAhead, "03:00:05"));
	await drain(runtime, MAX_RUNS);
}

async function checks(runtime: PluginRuntimeTestHost): Promise<Map<string, CheckRow>> {
	return new Map((await runtime.inspect.storage.list<CheckRow>("checks")).map(({ id, data }) => [id, data]));
}

function requestsTo(runtime: PluginRuntimeTestHost, host: string): string[] {
	return runtime.http
		.requests()
		.filter((request) => new URL(request.url).host === host)
		.map((request) => `${request.method} ${request.url}`);
}

const ok = () => new Response(null, { status: 200 });

describe("a scheduled sweep", () => {
	it("checks every entry on the night it starts", async () => {
		host = await site(["cta_url"]);
		for (let i = 0; i < ENTRIES; i++) {
			await post(host, `post-${i}`, { cta_url: `/page-${i}` });
			await host.http.respond(`https://example.test/page-${i}`, ok());
		}

		// The chain has to end by itself once the sweep is done.
		expect(await firstNight(host)).toBeLessThan(MAX_RUNS);

		const stored = await checks(host);
		expect(stored.size).toBe(ENTRIES);
		expect([...stored.values()].every((check) => check.state === "ok")).toBe(true);
	});

	it("checks a link shared by several entries once", async () => {
		host = await site(["source_url"]);
		for (const slug of ["a", "b", "c"]) await post(host, slug, { source_url: "https://shared.test/page#part" });
		await host.http.respond("https://shared.test/page", ok());

		await firstNight(host);

		expect(requestsTo(host, "shared.test")).toEqual(["HEAD https://shared.test/page"]);
		expect((await checks(host)).get("https://shared.test/page")).toMatchObject({ state: "ok", placeCount: 3 });
	});

	it("skips drafts, and forgets an entry's findings once it is unpublished", async () => {
		host = await site(["cta_url", "source_url"]);
		const live = await post(host, "live", { cta_url: "/old-page" });
		await post(host, "draft", { source_url: "https://draft.test/x" }, "draft");
		await host.http.respond(
			"https://example.test/old-page",
			new Response(null, { status: 301, headers: { location: "/new-page" } }),
		);

		await firstNight(host);
		expect((await checks(host)).get("https://example.test/old-page")).toMatchObject({ finding: "redirect" });
		expect(requestsTo(host, "draft.test")).toEqual([]);

		await host.actions.content.unpublish("posts", live.id);
		await nextNight(host, 2);

		expect(await checks(host)).toEqual(new Map());
	});

	it("reports a finding however many working links were checked before it", async () => {
		host = await site(["cta_url"]);
		for (let i = 0; i < 101; i++) {
			await post(host, `fine-${i}`, { cta_url: `/fine-${i}` });
			await host.http.respond(`https://example.test/fine-${i}`, ok());
		}
		await post(host, "stale", { cta_url: "/old-page" });
		await host.http.respond(
			"https://example.test/old-page",
			new Response(null, { status: 301, headers: { location: "/new-page" } }),
		);

		await firstNight(host);

		expect((await reportRows(host)).map((row) => row.url)).toEqual(["/old-page"]);
	}, FIXTURE_HEAVY_MS);

	it("keeps the report within emdash's limits when one link repeats across many entries", async () => {
		host = await site(["cta_url"]);
		for (let i = 0; i < 250; i++) await post(host, `post-${i}`, { cta_url: "/old-page" });
		await host.http.respond(
			"https://example.test/old-page",
			new Response(null, { status: 301, headers: { location: "/new-page" } }),
		);

		await firstNight(host);

		const rows = await reportRows(host);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.entry).toMatch(/ \+249 more$/);
	}, FIXTURE_HEAVY_MS);

	it("clears the findings of an entry unpublished while the plugin was switched off", async () => {
		host = await site(["cta_url"]);
		const live = await post(host, "live", { cta_url: "/old-page" });
		await host.http.respond(
			"https://example.test/old-page",
			new Response(null, { status: 301, headers: { location: "/new-page" } }),
		);
		await firstNight(host);
		expect((await checks(host)).size).toBe(1);

		await host.actions.plugin.deactivate();
		await host.actions.content.unpublish("posts", live.id);
		await host.actions.plugin.activate();
		await nextNight(host, 2);

		expect(await checks(host)).toEqual(new Map());
	});
});

describe("a requested sweep", () => {
	it("starts afresh when requested while another sweep is under way", async () => {
		host = await site(["cta_url"]);
		for (let i = 0; i < 40; i++) {
			await post(host, `post-${i}`, { cta_url: `/page-${i}` });
			// Once for the interrupted sweep, once for the one that replaces it.
			await host.http.respond(`https://example.test/page-${i}`, ok());
			await host.http.respond(`https://example.test/page-${i}`, ok());
		}
		host.scheduled.setTime(night(1, "02:59:00"));
		await host.actions.plugin.activate();
		host.scheduled.setTime(night(1, "03:00:05"));
		for (let i = 0; i < 4; i++) await host.scheduled.run();
		const interrupted = await host.inspect.kv.get<SweepState>("state");
		expect(interrupted?.phase).not.toBe("done");

		await host.actions.routes.request("admin", {
			method: "POST",
			headers: { "x-emdash-request": "1" },
			body: { type: "block_action", action_id: "sweep_now" },
			user: { id: "u1", email: "admin@example.test", name: null, role: ROLE.ADMIN, createdAt: "2026-01-01" },
		});
		await drain(host, MAX_RUNS);

		const finished = await host.inspect.kv.get<SweepState>("state");
		expect(finished?.phase).toBe("done");
		expect(finished?.startedAt && interrupted?.startedAt && finished.startedAt > interrupted.startedAt).toBe(true);
	});
});

describe("two nightly sweeps", () => {
	it("follow an outbound redirect, report an internal one, and leave a rate-limited host alone", async () => {
		host = await site(["cta_url", "source_url", "press_url", "docs_url"]);
		await post(host, "post", {
			cta_url: "/old-page",
			source_url: "https://busy.test/report",
			press_url: "https://moved.test/",
			docs_url: "https://busy.test/docs",
		});

		const internalHop = () => new Response(null, { status: 301, headers: { location: "/new-page" } });
		const outboundHop = () => new Response(null, { status: 301, headers: { location: "https://new.test/" } });
		// Longer than both nights, on the test clock and the real one alike.
		const rateLimited = () => new Response(null, { status: 429, headers: { "retry-after": String(7 * 86_400) } });

		// Every hop needs an answer: an unanswered request hangs the sandboxed
		// run instead of failing it.
		await host.http.respond("https://example.test/old-page", internalHop());
		await host.http.respond("https://moved.test/", outboundHop());
		await host.http.respond("https://new.test/", ok());
		await host.http.respond("https://busy.test/report", rateLimited());
		await host.http.respond("https://busy.test/docs", rateLimited());
		await firstNight(host);

		await host.http.respond("https://example.test/old-page", internalHop());
		await host.http.respond("https://moved.test/", outboundHop());
		await host.http.respond("https://new.test/", ok());
		await nextNight(host, 2);

		const stored = await checks(host);
		expect(stored.get("https://example.test/old-page")).toMatchObject({ state: "redirect", reported: true });
		expect(stored.get("https://moved.test/")).toMatchObject({
			state: "ok",
			finalUrl: "https://new.test/",
			reported: false,
		});
		// Whichever busy.test link comes first is asked; the host's 429 spares the other.
		const asked = requestsTo(host, "busy.test");
		expect(asked).toHaveLength(1);
		const askedUrl = asked[0]?.split(" ")[1] ?? "";
		expect(stored.get(askedUrl)).toMatchObject({ reason: "rate-limited", reported: false });
	});
});

/** The report table's rows, as the admin would receive them after emdash's Block Kit validation. */
async function reportRows(runtime: PluginRuntimeTestHost): Promise<Array<Record<string, string>>> {
	const response = await runtime.actions.routes.request("admin", {
		method: "POST",
		headers: { "x-emdash-request": "1" },
		body: { type: "page_load", page: "/report" },
		user: { id: "u1", email: "admin@example.test", name: null, role: ROLE.ADMIN, createdAt: "2026-01-01" },
	});
	const body = (await response.json()) as { data?: { blocks?: unknown }; error?: unknown };
	if (!Array.isArray(body.data?.blocks)) throw new Error(`report rejected: ${JSON.stringify(body.error)}`);
	const table = (body.data.blocks as Array<Record<string, unknown>>).find((block) => block.type === "table");
	return (table as { rows?: Array<Record<string, string>> } | undefined)?.rows ?? [];
}
