/**
 * Registering the recurring audit.
 */

import type { PluginContext } from "emdash/plugin";

import type { StoredSettings } from "./settings.js";

/** The recurring audit. `ctx.cron.schedule()` upserts on this name. */
export const AUDIT_TASK = "audit";

/**
 * Register the recurring audit on the stored schedule.
 *
 * `plugin:activate` fires only when a plugin is enabled or installed at
 * runtime. A plugin listed in `astro.config.mjs` is active from the start
 * and never sees it, so the admin surfaces call this too. They skip the call
 * when `scheduledAs` says the task already runs on this schedule. That
 * record can outlive the task, since an uninstall deletes cron tasks but
 * keeps plugin KV, so activation passes `force`.
 *
 * Returns whether `stored` changed and needs writing.
 */
export async function ensureScheduled(ctx: PluginContext, stored: StoredSettings, force = false): Promise<boolean> {
	const { schedule } = stored.settings;
	if (!ctx.cron || (!force && stored.scheduledAs === schedule)) return false;
	await ctx.cron.schedule(AUDIT_TASK, { schedule });
	const changed = stored.scheduledAs !== schedule;
	stored.scheduledAs = schedule;
	return changed;
}
