import type { PluginContext } from "emdash/plugin";
import { describe, expect, it } from "vitest";

import { followUpPending, scheduleFollowUp, type SweepChain } from "../src/chain.js";

const CHAIN: SweepChain = { next: ["sweep-next-a", "sweep-next-b"], maxSteps: 3 };

function fakeCron(pending: string[] = []) {
	const scheduled: Array<{ name: string; data?: Record<string, unknown> }> = [];
	const ctx = {
		cron: {
			async schedule(name: string, opts: { schedule: string; data?: Record<string, unknown> }) {
				scheduled.push({ name, data: opts.data });
			},
			async list() {
				return pending.map((name) => ({ name, schedule: "2026-09-25T03:00:00.000Z" }));
			},
		},
	} as unknown as PluginContext;
	return { ctx, scheduled };
}

describe("scheduleFollowUp", () => {
	it("never reschedules the task that is running", async () => {
		const { ctx, scheduled } = fakeCron();
		await scheduleFollowUp(ctx, CHAIN, { name: "sweep" });
		await scheduleFollowUp(ctx, CHAIN, { name: "sweep-next-a", data: { step: 1 } });
		await scheduleFollowUp(ctx, CHAIN, { name: "sweep-next-b", data: { step: 2 } });
		expect(scheduled.map((task) => task.name)).toEqual(["sweep-next-a", "sweep-next-b", "sweep-next-a"]);
	});

	it("stops a chain that would otherwise run forever", async () => {
		const { ctx, scheduled } = fakeCron();
		let event: { name: string; data?: Record<string, unknown> } = { name: "sweep" };
		for (let run = 0; run < 10; run++) {
			if (!(await scheduleFollowUp(ctx, CHAIN, event))) break;
			event = scheduled[scheduled.length - 1]!;
		}
		expect(scheduled).toHaveLength(CHAIN.maxSteps);
	});
});

describe("followUpPending", () => {
	it("sees a waiting follow-up, so a new run does not start a second chain", async () => {
		expect(await followUpPending(fakeCron(["sweep", "sweep-next-b"]).ctx, CHAIN)).toBe(true);
		expect(await followUpPending(fakeCron(["sweep", "sweep-now"]).ctx, CHAIN)).toBe(false);
	});
});
