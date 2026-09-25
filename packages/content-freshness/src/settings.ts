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

import { ID_BATCH } from "./ids.js";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./rules.js";

export const SETTINGS_KEY = "settings";

/**
 * What one collection sets for itself. A missing threshold means the site's
 * default; 0 switches the rule off for the collection.
 */
export interface CollectionOverride {
	staleMonths?: number;
	draftMonths?: number;
	/** Leave the collection out of the audit altogether. */
	skip?: boolean;
}

export interface Settings extends Thresholds {
	/** Entries per cron run, at most `ID_BATCH`. */
	pageSize: number;
	schedule: string;
	collections: Record<string, CollectionOverride>;
}

export const DEFAULT_SETTINGS: Settings = {
	...DEFAULT_THRESHOLDS,
	pageSize: 50,
	schedule: "0 4 * * *",
	collections: {},
};

/** A collection slug as EmDash allows it. Anything else in stored settings is dropped. */
const SLUG = /^[a-z][a-z0-9_]*$/;

/** A form field for one collection's setting: `collection:<slug>:<setting>`. */
const COLLECTION_FIELD = /^collection:([a-z][a-z0-9_]*):(staleMonths|draftMonths|skip)$/;

export function collectionField(slug: string, setting: keyof CollectionOverride): string {
	return `collection:${slug}:${setting}`;
}

/** The thresholds that apply to `collection`, and whether it is audited at all. */
export function thresholdsFor(settings: Settings, collection: string): Thresholds & { skip: boolean } {
	const own = settings.collections[collection] ?? {};
	return {
		staleMonths: own.staleMonths ?? settings.staleMonths,
		draftMonths: own.draftMonths ?? settings.draftMonths,
		descriptionMin: settings.descriptionMin,
		descriptionMax: settings.descriptionMax,
		reportMissingDescriptions: settings.reportMissingDescriptions,
		skip: own.skip === true,
	};
}

type NumberKey = "pageSize" | "staleMonths" | "draftMonths" | "descriptionMin" | "descriptionMax";

const NUMBERS: Array<[NumberKey, number, number]> = [
	["pageSize", 1, ID_BATCH],
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
	settings.collections = normalizeOverrides(source.collections);
	return settings;
}

function normalizeOverrides(source: unknown): Record<string, CollectionOverride> {
	if (typeof source !== "object" || source === null) return {};
	const overrides: Record<string, CollectionOverride> = {};
	for (const [slug, raw] of Object.entries(source as Record<string, unknown>)) {
		if (!SLUG.test(slug) || typeof raw !== "object" || raw === null) continue;
		const { staleMonths, draftMonths, skip } = raw as Record<string, unknown>;
		const own: CollectionOverride = {};
		if (isSet(staleMonths)) own.staleMonths = clampNumber(staleMonths, 0, 120, 0);
		if (isSet(draftMonths)) own.draftMonths = clampNumber(draftMonths, 0, 120, 0);
		if (skip === true) own.skip = true;
		if (Object.keys(own).length > 0) overrides[slug] = own;
	}
	return overrides;
}

/** A form's empty number field arrives as `undefined`, `null` or `""`: no override. */
function isSet(value: unknown): boolean {
	return value !== undefined && value !== null && !(typeof value === "string" && !value.trim());
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

	const collections: Record<string, Record<string, unknown>> = {};
	for (const [slug, own] of Object.entries(current.collections)) collections[slug] = { ...own };
	for (const [key, value] of Object.entries(values)) {
		const match = COLLECTION_FIELD.exec(key);
		if (!match) continue;
		const [, slug, setting] = match as unknown as [string, string, keyof CollectionOverride];
		const own = (collections[slug] ??= {});
		if (setting === "skip") own.skip = value === true;
		else if (isSet(value)) own[setting] = value;
		else delete own[setting];
	}
	merged.collections = collections;
	return normalizeSettings(merged);
}
