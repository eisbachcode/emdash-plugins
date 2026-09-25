/**
 * Date windows for the sync job. Pure, so the rules that matter can be
 * tested without a provider.
 *
 * Everything here is UTC. Cloudflare's GraphQL API has no timezone
 * concept — `date` is a UTC calendar day — while the Cloudflare dashboard
 * renders in the viewer's local timezone. Mixing the two is the single
 * easiest way to produce numbers that look wrong for reasons that have
 * nothing to do with the plugin.
 */

/**
 * How far back `date_geq` may reach before Cloudflare switches the whole
 * query to its aggregated sample.
 *
 * This is the most important number in the plugin. Measured against a live
 * account on 2026-09-20, holding `date_leq` at today and walking `date_geq`
 * backwards one day at a time:
 *
 *   date_geq  today-6  ->  25 page views, sampleInterval 1.47
 *   date_geq  today-7  ->  31 page views, sampleInterval 1.35
 *   date_geq  today-8  ->  10 page views, sampleInterval 10
 *   date_geq  today-9  ->  10 page views, sampleInterval 10
 *
 * Widening the window by one single day cut the reported total from 31 to
 * 10. Past the cliff every value is a multiple of ten, and days quiet
 * enough to contribute no sampled row disappear from the response
 * altogether — a day that reports 7 views in a one-day window is simply
 * absent from any query starting eight days back.
 *
 * The sampling decision is made per query, from the oldest day requested,
 * and then applied to every day in the result including today. So a wider
 * window is not a cheaper request, it is a corrupt one, and no caller may
 * widen it to save a round trip.
 */
export const UNSAMPLED_WINDOW_DAYS = 7;

/**
 * Days of overlap re-fetched on every tick.
 *
 * Beacon data arrives late, and today's row is never final anyway (see
 * `isProvisional`), so each tick re-reads the last few days and lets the
 * newer answer win until the day freezes.
 */
export const DEFAULT_OVERLAP_DAYS = 2;

const MS_PER_DAY = 86_400_000;

/** A UTC calendar day, `YYYY-MM-DD` — the format the API speaks. */
export type Day = string;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: unknown): value is Day {
	return typeof value === "string" && DAY_PATTERN.test(value);
}

/** The UTC calendar day containing `at`. */
export function utcDay(at: Date): Day {
	return at.toISOString().slice(0, 10);
}

function dayToMs(day: Day): number {
	const ms = Date.parse(`${day}T00:00:00.000Z`);
	if (Number.isNaN(ms)) throw new RangeError(`Not a UTC day: ${day}`);
	return ms;
}

/** Shift a day by whole days. Negative moves backwards. */
export function addDays(day: Day, delta: number): Day {
	return utcDay(new Date(dayToMs(day) + delta * MS_PER_DAY));
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: Day, to: Day): number {
	return Math.round((dayToMs(to) - dayToMs(from)) / MS_PER_DAY);
}

/** Every day in `[since, until]`, ascending and inclusive. */
export function enumerateDays(since: Day, until: Day): Day[] {
	const span = daysBetween(since, until);
	if (span < 0) return [];
	return Array.from({ length: span + 1 }, (_, i) => addDays(since, i));
}

export interface SyncWindow {
	/** `date_geq` — never older than the unsampled cliff. */
	since: Day;
	/** `date_leq` — today, in UTC. */
	until: Day;
	/** True when the requested overlap had to be shortened to stay unsampled. */
	clamped: boolean;
}

/**
 * The window a tick may ask Cloudflare for.
 *
 * `overlapDays` is a request, not a promise: it is clamped to the
 * provider's exact window (`UNSAMPLED_WINDOW_DAYS` for Cloudflare) because
 * exceeding it silently corrupts every number in the response rather than
 * merely returning more of them.
 */
export function syncWindow(
	now: Date,
	overlapDays: number = DEFAULT_OVERLAP_DAYS,
	exactDays: number = UNSAMPLED_WINDOW_DAYS,
): SyncWindow {
	const until = utcDay(now);
	const wanted = Math.max(0, Math.trunc(overlapDays));
	const allowed = Math.min(wanted, Math.max(0, Math.trunc(exactDays)));
	return { since: addDays(until, -allowed), until, clamped: allowed < wanted };
}

/**
 * The widest window that is still exact, used by the first-run backfill.
 *
 * Anything older than this has to come from the sampled aggregate, so the
 * backfill stops here and the UI says the store starts on this day rather
 * than inventing tenfold-quantized history.
 */
export function backfillWindow(now: Date, exactDays: number = UNSAMPLED_WINDOW_DAYS): SyncWindow {
	return syncWindow(now, exactDays, exactDays);
}

/**
 * Is a day still open, or recent enough that its numbers may still move?
 *
 * Today is always provisional: a one-day query for today reported
 * `sampleInterval` 2.1 to 2.3 in the 2026-09-20 measurements, while every
 * closed day inside the unsampled window reported exactly 1. So today is
 * an estimate by construction, and the UI has to say so.
 */
export function isProvisional(day: Day, today: Day): boolean {
	return daysBetween(day, today) <= 0;
}

/**
 * May a stored row for `day` be overwritten by a freshly fetched one?
 *
 * A day freezes once it is closed, old enough that late beacons have
 * stopped arriving, and was last written from an unsampled response.
 * Frozen rows are the plugin's exact history — after seven days
 * Cloudflare itself can no longer reproduce them — so nothing overwrites
 * one, least of all a sampled re-read.
 */
export function isFrozen(day: Day, today: Day, storedSampleInterval: number, freezeAfterDays: number = DEFAULT_OVERLAP_DAYS): boolean {
	if (isProvisional(day, today)) return false;
	if (daysBetween(day, today) < freezeAfterDays) return false;
	return storedSampleInterval === 1;
}

/**
 * Is a response exact enough to be written as history?
 *
 * `sampleInterval` 1 means Cloudflare counted every beacon. Anything above
 * 1 is an estimate: `count` is already scaled up by this factor, so the
 * number is not raw, it is extrapolated.
 */
export function isExact(sampleInterval: number): boolean {
	return sampleInterval === 1;
}
