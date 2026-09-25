/**
 * The plugin's own message catalogue.
 *
 * Block Kit plugins localize themselves: the host passes the administrator's
 * locale in `routeCtx.ui` and does not consume plugin catalogues. English is
 * the source and the fallback; `de` is typed against its keys, so a missing
 * German entry fails the typecheck. Manifest strings (page labels, widget and
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
	panelSkipped: "This collection is left out of the freshness audit.",
	markReviewed: "Mark as reviewed",
	ignore: "Ignore",
	undo: "Undo",
	reviewedUntil: "Marked as reviewed; checked again from {date}.",
	ignored: "Ignored.",
	dismissedHeader: "Set aside",

	settingsTitle: "Freshness settings",
	settingsIntro: "These thresholds apply to every collection unless a collection sets its own at the end of the form.",
	staleMonths: "Months before a published entry counts as stale",
	draftMonths: "Months before a draft counts as forgotten",
	descriptionMin: "Shortest acceptable SEO description",
	descriptionMax: "Longest acceptable SEO description",
	reportMissing: "Report entries without an SEO description",
	reportMissingHelp: "Switch off if your templates always render a description of their own.",
	pageSize: "Entries per run",
	schedule: "Schedule (cron, UTC)",
	pendingDays: "Days before unpublished changes to a published entry count as forgotten",
	collectionExpiry: "{collection}: expires after the date in",
	expiryUnset: "Not checked",
	expirySuggested: "{field} (suggested)",
	expiryOff: "Never expires",
	expirySuggestTitle: "Expiry dates not checked: {names}",
	expirySuggestText:
		"These collections have a date field that looks like an expiry date. Choose it in the Freshness settings to report entries still published after it, or choose “Never expires”.",
	openSettings: "Open settings",
	collectionStale: "{collection}: months before an entry is stale (empty: {months}, 0: never)",
	collectionDraft: "{collection}: months before a draft is forgotten (empty: {months}, 0: never)",
	collectionSkip: "{collection}: leave out of the audit",
	save: "Save",
	saved: "Settings saved.",
	notSaved: "Settings not saved. {reason}",
	adminOnly: "Only an administrator can change these settings.",

	hitOverduePublish: "Scheduled to go live on {date}, but it never did.",
	hitOverdueUpdate: "Changes scheduled for {date} were never published.",
	hitMissingDescription: "Published without an SEO description.",
	hitMissingFallback: "No SEO description; templates often show the “{field}” field instead.",
	hitDescriptionLength: "SEO description is {length} characters; aim for {min}–{max}.",
	hitStale: "Not touched since {since}.",
	hitStaleDraft: "Draft untouched since {since}.",
	hitUnpublishedChanges: "Changes saved on {since} are not published yet.",
	hitExpired: "{field} was {date}, and the entry is still published.",
} satisfies Record<string, Message>;

export type MessageKey = keyof typeof en;

const de: Record<MessageKey, Message> = {
	reportTitle: "Aktualität der Inhalte",
	priorityHigh: "Dringend",
	priorityMedium: "Bald erledigen",
	priorityLow: "Bei Gelegenheit",
	statEntries: "Einträge",
	auditRunning: "Prüfung läuft seit {date}",
	auditLast: "Letzte Prüfung {date}",
	auditPending: "Erste Prüfung steht aus",
	nothingTitle: "Alles aktuell",
	nothingText: "Keine veralteten Einträge, keine fehlenden Beschreibungen, keine verpassten Termine.",
	noMatch: "Kein Eintrag passt zu diesem Filter.",
	filterCollection: "Kollektion",
	filterPriority: "Priorität",
	filterAll: "Alle",
	open: "Öffnen",
	nextPage: "Nächste Seite",
	firstPage: "Erste Seite",
	auditNow: "Jetzt prüfen",
	auditContinues: "Die laufende Prüfung geht mit dem nächsten geplanten Lauf weiter.",
	auditStarts: "Die Prüfung startet mit dem nächsten geplanten Lauf.",
	urlPatternTitle: "Kein URL-Muster: {names}",
	urlPatternDetail:
		"EmDash verlinkt ihre Einträge in der Sitemap und im Admin als /{collection}/{slug}. Das stimmt nur, wenn die Website genau diese Routen verwendet. Lege unter Inhaltstypen ein URL-Muster fest oder schalte das Routing für eine Kollektion ohne eigene Seiten ab.",
	urlPatternShort: "Sitemap-Links dieser Kollektionen sind möglicherweise falsch.",

	widgetClear: "Alles aktuell",
	widgetLastAudit: "Letzte Prüfung {date}.",
	widgetPending: "Läuft mit der nächsten geplanten Prüfung.",
	widgetYours: { one: "{count} davon ist deiner", other: "{count} davon sind deine" },
	openReport: "Bericht öffnen",

	panelClear: "Hier gibt es nichts zu tun.",
	panelSkipped: "Diese Kollektion ist von der Prüfung ausgenommen.",
	markReviewed: "Als geprüft markieren",
	ignore: "Ignorieren",
	undo: "Rückgängig",
	reviewedUntil: "Als geprüft markiert; wird ab {date} wieder geprüft.",
	ignored: "Ignoriert.",
	dismissedHeader: "Zurückgestellt",

	settingsTitle: "Einstellungen zur Aktualität",
	settingsIntro:
		"Diese Schwellen gelten für alle Kollektionen, außer eine Kollektion legt am Ende des Formulars eigene fest.",
	staleMonths: "Monate, bis ein veröffentlichter Eintrag als veraltet gilt",
	draftMonths: "Monate, bis ein Entwurf als vergessen gilt",
	descriptionMin: "Kürzeste akzeptable SEO-Beschreibung",
	descriptionMax: "Längste akzeptable SEO-Beschreibung",
	reportMissing: "Einträge ohne SEO-Beschreibung melden",
	reportMissingHelp: "Schalte das ab, wenn deine Templates immer eine eigene Beschreibung ausgeben.",
	pageSize: "Einträge pro Lauf",
	schedule: "Zeitplan (Cron, UTC)",
	pendingDays: "Tage, bis unveröffentlichte Änderungen an einem veröffentlichten Eintrag als vergessen gelten",
	collectionExpiry: "{collection}: läuft ab nach dem Datum in",
	expiryUnset: "Nicht geprüft",
	expirySuggested: "{field} (vorgeschlagen)",
	expiryOff: "Läuft nie ab",
	expirySuggestTitle: "Ablaufdaten nicht geprüft: {names}",
	expirySuggestText:
		"Diese Kollektionen haben ein Datumsfeld, das nach einem Ablaufdatum aussieht. Wähle es in den Einstellungen zur Aktualität, um Einträge zu melden, die danach noch veröffentlicht sind, oder wähle „Läuft nie ab“.",
	openSettings: "Einstellungen öffnen",
	collectionStale: "{collection}: Monate, bis ein Eintrag veraltet ist (leer: {months}, 0: nie)",
	collectionDraft: "{collection}: Monate, bis ein Entwurf vergessen ist (leer: {months}, 0: nie)",
	collectionSkip: "{collection}: von der Prüfung ausnehmen",
	save: "Speichern",
	saved: "Einstellungen gespeichert.",
	notSaved: "Einstellungen nicht gespeichert. {reason}",
	adminOnly: "Nur Administratoren können diese Einstellungen ändern.",

	hitOverduePublish: "Sollte am {date} live gehen, ist es aber nie.",
	hitOverdueUpdate: "Die für {date} geplanten Änderungen wurden nie veröffentlicht.",
	hitMissingDescription: "Veröffentlicht ohne SEO-Beschreibung.",
	hitMissingFallback: "Keine SEO-Beschreibung; Templates zeigen oft stattdessen das Feld „{field}“.",
	hitDescriptionLength: "Die SEO-Beschreibung hat {length} Zeichen; empfohlen sind {min}–{max}.",
	hitStale: "Seit {since} nicht bearbeitet.",
	hitStaleDraft: "Entwurf seit {since} nicht bearbeitet.",
	hitUnpublishedChanges: "Am {since} gespeicherte Änderungen sind noch nicht veröffentlicht.",
	hitExpired: "{field} war am {date}, der Eintrag ist aber noch veröffentlicht.",
};

const catalogues = { en, de } as const;

export type Lang = keyof typeof catalogues;
export type Params = Record<string, string | number>;

/** The catalogue for an admin locale: `de`, `de-AT` and `de-CH` read German, everything else English. */
export function langOf(locale: string | undefined): Lang {
	return locale?.toLowerCase().split(/[-_]/)[0] === "de" ? "de" : "en";
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
