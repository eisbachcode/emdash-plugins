/**
 * The plugin's own message catalogue.
 *
 * Block Kit plugins localize themselves: the host passes the administrator's
 * locale in `routeCtx.ui` and does not consume plugin catalogues. English is
 * the source and the fallback. Manifest strings (page labels, widget and
 * panel titles) stay static. Logs stay English.
 */

type Plural = { one: string; other: string };
type Message = string | Plural;

const en = {
	reportTitle: "Content freshness",
	priorityHigh: "Urgent",
	priorityMedium: "Should fix",
	priorityLow: "Nice to fix",
	statEntries: "Entries",
	auditRunning: "Audit in progress since {date}",
	auditLast: "Last audit {date}",
	auditPending: "First audit pending",
	nothingTitle: "Nothing needs attention",
	nothingText: "No stale entries, no missing descriptions, no overdue schedules.",
	noMatch: "No entry matches this filter.",
	filterCollection: "Collection",
	filterPriority: "Priority",
	filterAll: "All",
	open: "Open",
	nextPage: "Next page",
	firstPage: "First page",
	auditNow: "Audit now",
	auditContinues: "The running audit continues with the next scheduled run.",
	auditStarts: "The audit starts with the next scheduled run.",
	urlPatternTitle: "No URL pattern: {names}",
	urlPatternDetail:
		"EmDash links their entries as /{collection}/{slug} in the sitemap and the admin, which is wrong unless the site uses exactly those routes. Set a URL pattern under Content Types, or switch off routing for a collection that has no pages of its own.",
	urlPatternShort: "Sitemap links for these collections may be broken.",

	widgetClear: "Everything current",
	widgetLastAudit: "Last audit {date}.",
	widgetPending: "Runs on the next scheduled audit.",
	widgetYours: { one: "{count} of them is yours", other: "{count} of them are yours" },
	openReport: "Open report",

	panelClear: "Nothing to fix here.",
	markReviewed: "Mark as reviewed",
	ignore: "Ignore",
	undo: "Undo",
	reviewedUntil: "Marked as reviewed; checked again from {date}.",
	ignored: "Ignored.",
	dismissedHeader: "Set aside",

	settingsTitle: "Freshness settings",
	settingsIntro: "These thresholds apply to every collection unless a collection sets its own below.",
	staleMonths: "Months before a published entry counts as stale",
	draftMonths: "Months before a draft counts as forgotten",
	descriptionMin: "Shortest acceptable SEO description",
	descriptionMax: "Longest acceptable SEO description",
	reportMissing: "Report entries without an SEO description",
	reportMissingHelp: "Switch off if your templates always render a description of their own.",
	pageSize: "Entries per run",
	schedule: "Schedule (cron, UTC)",
	collectionsHeader: "Per collection",
	collectionStale: "{collection}: months before stale (0 = never)",
	collectionDraft: "{collection}: months before a draft is forgotten (0 = never)",
	collectionSkip: "{collection}: leave out of the audit",
	useDefault: "Leave empty for the default of {months}.",
	save: "Save",
	saved: "Settings saved.",
	notSaved: "Settings not saved. {reason}",
	adminOnly: "Only an administrator can change these settings.",

	hitOverduePublish: "Scheduled for {date} but still {status}.",
	hitOverdueUpdate: "Changes scheduled for {date} were never published.",
	hitMissingDescription: "Published without an SEO description.",
	hitMissingFallback: "No SEO description; templates often show the “{field}” field instead.",
	hitDescriptionLength: "SEO description is {length} characters; aim for {min}–{max}.",
	hitStale: "Not touched since {since}.",
	hitStaleDraft: "Draft untouched since {since}.",
	statusDraft: "a draft",
	statusScheduled: "scheduled",
	statusOther: "{status}",
} satisfies Record<string, Message>;

export type MessageKey = keyof typeof en;

const catalogues = { en } as const;

export type Lang = keyof typeof catalogues;
export type Params = Record<string, string | number>;

/** The catalogue for an admin locale. English until a catalogue exists for it. */
export function langOf(_locale: string | undefined): Lang {
	return "en";
}

export function t(lang: Lang, key: MessageKey, params: Params = {}): string {
	const message: Message = catalogues[lang][key];
	const template =
		typeof message === "string"
			? message
			: new Intl.PluralRules(lang).select(Number(params.count ?? 0)) === "one"
				? message.one
				: message.other;
	return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}
