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
import { DEFAULT_THRESHOLDS, detectExpiryField, type EntryContext, type ExpiryField, type Thresholds } from "./rules.js";

export const SETTINGS_KEY = "settings";

/**
 * What one collection sets for itself. A missing threshold means the site's
 * default; 0 switches the rule off for the collection.
 */
export interface CollectionOverride {
	staleMonths?: number;
	draftMonths?: number;
	/**
	 * The `datetime` field entries expire after, or `"off"` for never. Unset,
	 * no expiry is checked and the report suggests a field whose name fits.
	 */
	expiryField?: string;
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
const COLLECTION_FIELD = /^collection:([a-z][a-z0-9_]*):(staleMonths|draftMonths|expiryField|skip)$/;

/** The expiry select's value for "not chosen yet": nothing checked, a field suggested. */
export const EXPIRY_UNSET = "unset";
/** The expiry select's value for "entries of this collection never expire": nothing checked or suggested. */
export const EXPIRY_OFF = "off";

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
		pendingDays: settings.pendingDays,
		skip: own.skip === true,
	};
}

/**
 * The field `collection`'s entries expire after, when the settings chose one
 * the collection still has. Expiry is opt-in: a site that keeps past events
 * online as an archive would otherwise get a finding for every one of them
 * the moment the plugin is installed. `fields` are the collection's
 * `datetime` fields.
 */
export function expiryFor(settings: Settings, collection: string, fields: ExpiryField[]): ExpiryField | null {
	const chosen = settings.collections[collection]?.expiryField;
	return fields.find((field) => field.slug === chosen) ?? null;
}

/** What the rules need to know about `collection`, from what a sweep or a check read about it. */
export function contextFor(
	settings: Settings,
	collection: string,
	info: { dateFields: ExpiryField[]; revisions: boolean } | undefined,
): EntryContext {
	return {
		expiry: expiryFor(settings, collection, info?.dateFields ?? []),
		revisions: info?.revisions ?? false,
	};
}

/** A field to suggest for a collection whose expiry nobody has decided on yet. */
export function suggestedExpiry(settings: Settings, collection: string, fields: ExpiryField[]): ExpiryField | null {
	if (settings.collections[collection]?.expiryField !== undefined) return null;
	return detectExpiryField(fields);
}

type NumberKey = "pageSize" | "staleMonths" | "draftMonths" | "descriptionMin" | "descriptionMax" | "pendingDays";

const NUMBERS: Array<[NumberKey, number, number]> = [
	["pageSize", 1, ID_BATCH],
	["staleMonths", 1, 120],
	["draftMonths", 1, 120],
	["descriptionMin", 0, 300],
	["descriptionMax", 0, 300],
	["pendingDays", 1, 365],
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
		const { staleMonths, draftMonths, expiryField, skip } = raw as Record<string, unknown>;
		const own: CollectionOverride = {};
		const stale = months(staleMonths);
		const draft = months(draftMonths);
		if (stale !== undefined) own.staleMonths = stale;
		if (draft !== undefined) own.draftMonths = draft;
		if (skip === true) own.skip = true;
		if (typeof expiryField === "string" && (expiryField === EXPIRY_OFF || SLUG.test(expiryField))) {
			own.expiryField = expiryField;
		}
		if (Object.keys(own).length > 0) overrides[slug] = own;
	}
	return overrides;
}

/**
 * An override's months, or nothing. A value that is not a number is dropped
 * rather than clamped, because 0 would switch the rule off.
 */
function months(value: unknown): number | undefined {
	if (!isSet(value)) return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? clampNumber(n, 0, 120, 0) : undefined;
}

/** An empty number field: no override. */
function isSet(value: unknown): boolean {
	return value !== undefined && value !== null && !(typeof value === "string" && !value.trim());
}

/**
 * `current` with the submitted form values applied. Unknown keys are ignored.
 *
 * `shown` names the collections whose fields the form carried. The admin
 * drops an emptied number field from the submission altogether, so for those
 * collections a missing month field means the admin cleared it.
 */
export function applyForm(current: Settings, values: Record<string, unknown>, shown: string[] = []): Settings {
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
	for (const slug of shown) {
		for (const setting of ["staleMonths", "draftMonths"] as const) {
			if (!(collectionField(slug, setting) in values)) delete collections[slug]?.[setting];
		}
	}
	for (const [key, value] of Object.entries(values)) {
		const match = COLLECTION_FIELD.exec(key);
		if (!match) continue;
		const [, slug, setting] = match as unknown as [string, string, keyof CollectionOverride];
		const own = (collections[slug] ??= {});
		if (setting === "skip") own.skip = value === true;
		else if (setting === "expiryField") {
			if (typeof value === "string" && value !== EXPIRY_UNSET) own.expiryField = value;
			else delete own.expiryField;
		} else if (isSet(value)) own[setting] = value;
		else delete own[setting];
	}
	merged.collections = collections;
	return normalizeSettings(merged);
}
