/**
 * Settings in plugin KV under `settings:*`. A standard-format plugin has
 * no declarative `settingsSchema` — that is native-only — so the form is
 * hand-built in `report.ts`.
 */

import { clampNumber } from "@eisbachcode/emdash-plugin-shared";
import type { PluginContext } from "emdash/plugin";

import { DEFAULT_THRESHOLDS, type Thresholds } from "./rules.js";

export interface Settings extends Thresholds {
	/** Entries per cron tick. */
	pageSize: number;
	schedule: string;
}

export const DEFAULT_SETTINGS: Settings = {
	...DEFAULT_THRESHOLDS,
	pageSize: 50,
	schedule: "0 4 * * *",
};

export async function readSettings(ctx: PluginContext): Promise<Settings> {
	const [pageSize, schedule, staleMonths, draftMonths, descriptionMin, descriptionMax, reportMissing] =
		await Promise.all([
			ctx.kv.get<number>("settings:pageSize"),
			ctx.kv.get<string>("settings:schedule"),
			ctx.kv.get<number>("settings:staleMonths"),
			ctx.kv.get<number>("settings:draftMonths"),
			ctx.kv.get<number>("settings:descriptionMin"),
			ctx.kv.get<number>("settings:descriptionMax"),
			ctx.kv.get<boolean>("settings:reportMissingDescriptions"),
		]);

	const min = clampNumber(descriptionMin, 0, 300, DEFAULT_SETTINGS.descriptionMin);
	const max = clampNumber(descriptionMax, 0, 300, DEFAULT_SETTINGS.descriptionMax);

	return {
		pageSize: clampNumber(pageSize, 1, 200, DEFAULT_SETTINGS.pageSize),
		schedule: typeof schedule === "string" && schedule.trim() ? schedule.trim() : DEFAULT_SETTINGS.schedule,
		staleMonths: clampNumber(staleMonths, 1, 120, DEFAULT_SETTINGS.staleMonths),
		draftMonths: clampNumber(draftMonths, 1, 120, DEFAULT_SETTINGS.draftMonths),
		descriptionMin: Math.min(min, max),
		descriptionMax: Math.max(min, max),
		reportMissingDescriptions:
			typeof reportMissing === "boolean" ? reportMissing : DEFAULT_SETTINGS.reportMissingDescriptions,
	};
}

export async function writeSettings(ctx: PluginContext, values: Record<string, unknown>): Promise<void> {
	if (typeof values.schedule === "string" && values.schedule.trim())
		await ctx.kv.set("settings:schedule", values.schedule.trim());
	if (typeof values.reportMissingDescriptions === "boolean")
		await ctx.kv.set("settings:reportMissingDescriptions", values.reportMissingDescriptions);

	const numbers: Array<[string, number, number, number]> = [
		["pageSize", 1, 200, DEFAULT_SETTINGS.pageSize],
		["staleMonths", 1, 120, DEFAULT_SETTINGS.staleMonths],
		["draftMonths", 1, 120, DEFAULT_SETTINGS.draftMonths],
		["descriptionMin", 0, 300, DEFAULT_SETTINGS.descriptionMin],
		["descriptionMax", 0, 300, DEFAULT_SETTINGS.descriptionMax],
	];
	for (const [key, min, max, fallback] of numbers) {
		if (values[key] !== undefined) {
			await ctx.kv.set(`settings:${key}`, clampNumber(values[key], min, max, fallback));
		}
	}
}
