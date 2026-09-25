/**
 * Settings, stored as one object under one KV key. Every `ctx` call is a
 * subrequest in the sandbox, and a key per setting cost seven of the ten a
 * cron run gets. A standard-format plugin has no declarative
 * `settingsSchema` — that is native-only — so the form is hand-built in
 * `report.ts`.
 *
 * The same object records which schedule the recurring audit was last
 * registered with. Only admin requests write this key, so recording it here
 * never races a cron run's write of the sweep state.
 */

import { clampNumber } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext } from "emdash/plugin";

import { DEFAULT_THRESHOLDS, type Thresholds } from "./rules.js";

export const SETTINGS_KEY = "settings";

export interface Settings extends Thresholds {
	/** Entries per cron run. `content.list` returns at most 100. */
	pageSize: number;
	schedule: string;
}

export const DEFAULT_SETTINGS: Settings = {
	...DEFAULT_THRESHOLDS,
	pageSize: 50,
	schedule: "0 4 * * *",
};

type NumberKey = "pageSize" | "staleMonths" | "draftMonths" | "descriptionMin" | "descriptionMax";

const NUMBERS: Array<[NumberKey, number, number]> = [
	["pageSize", 1, 100],
	["staleMonths", 1, 120],
	["draftMonths", 1, 120],
	["descriptionMin", 0, 300],
	["descriptionMax", 0, 300],
];

export interface StoredSettings {
	settings: Settings;
	/** The expression the recurring audit was last scheduled with. */
	scheduledAs: string | null;
}

export async function readStoredSettings(ctx: PluginContext): Promise<StoredSettings> {
	const raw = await ctx.kv.get<Record<string, unknown>>(SETTINGS_KEY);
	return {
		settings: normalizeSettings(raw),
		scheduledAs: typeof raw?.scheduledAs === "string" ? raw.scheduledAs : null,
	};
}

export async function readSettings(ctx: PluginContext): Promise<Settings> {
	return (await readStoredSettings(ctx)).settings;
}

export async function writeStoredSettings(ctx: PluginContext, stored: StoredSettings): Promise<void> {
	await ctx.kv.set(SETTINGS_KEY, { ...stored.settings, scheduledAs: stored.scheduledAs });
}

/** Settings from whatever is stored, every value clamped and defaulted. */
export function normalizeSettings(stored: Record<string, unknown> | null | undefined): Settings {
	const source = stored ?? {};
	const settings = { ...DEFAULT_SETTINGS };
	for (const [key, min, max] of NUMBERS) {
		settings[key] = clampNumber(source[key], min, max, DEFAULT_SETTINGS[key]);
	}
	if (typeof source.schedule === "string" && source.schedule.trim()) settings.schedule = source.schedule.trim();
	if (typeof source.reportMissingDescriptions === "boolean") {
		settings.reportMissingDescriptions = source.reportMissingDescriptions;
	}
	const [min, max] = [settings.descriptionMin, settings.descriptionMax];
	settings.descriptionMin = Math.min(min, max);
	settings.descriptionMax = Math.max(min, max);
	return settings;
}

/** `current` with the submitted form values applied. Unknown keys are ignored. */
export function applyForm(current: Settings, values: Record<string, unknown>): Settings {
	const merged: Record<string, unknown> = { ...current };
	for (const [key] of NUMBERS) {
		if (values[key] !== undefined) merged[key] = values[key];
	}
	if (typeof values.schedule === "string" && values.schedule.trim()) merged.schedule = values.schedule;
	if (typeof values.reportMissingDescriptions === "boolean") {
		merged.reportMissingDescriptions = values.reportMissingDescriptions;
	}
	return normalizeSettings(merged);
}
