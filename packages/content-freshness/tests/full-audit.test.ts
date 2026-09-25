import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

/**
 * One scheduled run audits one page of one collection. A nightly schedule
 * that ran one page per night would need a night per collection, so a run
 * that made progress hands over to a follow-up run. Through the real
 * runtime and cron executor, because the executor deletes a finished
 * one-shot task by id and would throw away a follow-up scheduled under the
 * running task's own name.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

describe("a scheduled audit", () => {
	it("gets through every collection on the night it starts", async () => {
		host = await createPluginRuntimeTestHost();
		for (const slug of ["posts", "pages", "projects"]) {
			await host.fixtures.collection({ slug, label: slug });
			await host.fixtures.content(slug, { slug: `${slug}-1`, data: {} });
		}

		// Follow-ups are scheduled from the wall clock (`Date.now()`), not the
		// host's clock, so the night must lie ahead of the real time or they
		// never fall due. Tomorrow's night always does.
		const night = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
		host.scheduled.setTime(`${night}T03:59:00.000Z`);
		await host.actions.plugin.activate();
		host.scheduled.setTime(`${night}T04:00:05.000Z`);

		let runs = 0;
		for (; runs < 20; runs++) {
			if ((await host.scheduled.run()).processed === 0) break;
		}

		expect(runs).toBeLessThan(20);
		expect(await host.inspect.kv.get("state:lastSweepFinishedAt")).not.toBeNull();
	});
});
