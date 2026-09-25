/**
 * Settings, stored in plugin KV as one object under `settings`, so any
 * invocation reads them in one bridge call.
 *
 * A standard-format (sandboxed) plugin has no declarative
 * `settingsSchema` — that is a native-plugin feature. So the form is
 * built by hand in `report.ts` and written through here, which is also
 * what upstream's own `webhook-notifier` does.
 */

import { clampNumber } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext } from "emdash/plugin";

export { clampNumber };

export const SETTINGS_KEY = "settings";

export interface Settings {
	/** Entries read per step of the walk over the site's content. */
	batchSize: number;
	/** Cron expression for the sweep. */
	schedule: string;
	/** Check outbound links, not just internal ones. */
	checkExternal: boolean;
	/** Consecutive failures before a link is reported as broken. */
	failureThreshold: number;
}

export const DEFAULT_SETTINGS: Settings = {
	batchSize: 25,
	schedule: "0 3 * * *",
	checkExternal: true,
	failureThreshold: 2,
};

/** Settings from whatever is stored, each value falling back to its default. */
export function settingsFrom(stored: unknown): Settings {
	const raw = (stored ?? {}) as Partial<Record<keyof Settings, unknown>>;
	return {
		batchSize: clampNumber(raw.batchSize, 1, 100, DEFAULT_SETTINGS.batchSize),
		schedule:
			typeof raw.schedule === "string" && raw.schedule.trim() ? raw.schedule.trim() : DEFAULT_SETTINGS.schedule,
		checkExternal: typeof raw.checkExternal === "boolean" ? raw.checkExternal : DEFAULT_SETTINGS.checkExternal,
		failureThreshold: clampNumber(raw.failureThreshold, 1, 10, DEFAULT_SETTINGS.failureThreshold),
	};
}

export async function readSettings(ctx: PluginContext): Promise<Settings> {
	return settingsFrom(await ctx.kv.get(SETTINGS_KEY));
}

/** Submitted form values over the current settings; unknown keys are ignored. */
export function mergeSettings(current: Settings, values: Record<string, unknown>): Settings {
	return settingsFrom({
		batchSize: values.batchSize ?? current.batchSize,
		schedule: typeof values.schedule === "string" && values.schedule.trim() ? values.schedule : current.schedule,
		checkExternal: typeof values.checkExternal === "boolean" ? values.checkExternal : current.checkExternal,
		failureThreshold: values.failureThreshold ?? current.failureThreshold,
	});
}
