/**
 * Carrying a sweep across cron runs until it is finished.
 *
 * One run does one bounded slice of work, because a sandboxed plugin gets
 * 10 subrequests per invocation. A sweep started by a nightly schedule would
 * otherwise advance one slice per night. So a run that made progress
 * schedules a one-shot follow-up, and the chain ends when the sweep does.
 *
 * The follow-up alternates between two task names. emdash deletes a
 * finished one-shot task by id, and `ctx.cron.schedule()` upserts on the
 * task name, so a follow-up scheduled under the running task's own name
 * updates the row that is about to be deleted, and the chain ends silently.
 */

import type { PluginContext } from "emdash/plugin";

export interface SweepChain {
	/** Two one-shot task names the follow-ups alternate between. */
	next: readonly [string, string];
	/** Follow-ups after which a chain stops and waits for the next scheduled run. */
	maxSteps: number;
}

export interface ChainEvent {
	name: string;
	data?: Record<string, unknown>;
}

export function isFollowUp(chain: SweepChain, name: string): boolean {
	return chain.next.includes(name);
}

/**
 * Whether a follow-up is already waiting. A scheduled run or a "now" button
 * that started work anyway would run a second chain alongside the first.
 */
export async function followUpPending(ctx: PluginContext, chain: SweepChain): Promise<boolean> {
	const tasks = (await ctx.cron?.list()) ?? [];
	return tasks.some((task) => isFollowUp(chain, task.name));
}

/** Schedule the next run of the chain. Returns false once the chain has reached `maxSteps`. */
export async function scheduleFollowUp(ctx: PluginContext, chain: SweepChain, event: ChainEvent): Promise<boolean> {
	const step = typeof event.data?.step === "number" ? event.data.step : 0;
	if (step >= chain.maxSteps) return false;
	const name = event.name === chain.next[0] ? chain.next[1] : chain.next[0];
	await ctx.cron?.schedule(name, {
		schedule: new Date(Date.now() + 1000).toISOString(),
		data: { step: step + 1 },
	});
	return true;
}
