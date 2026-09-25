# content-freshness

Scheduled freshness audit for [EmDash](https://emdashcms.com) content. Finds the
entries that quietly went stale and puts them in one list in the admin.

What it looks for:

| Finding | Priority |
| --- | --- |
| Scheduled to publish, or scheduled changes to a published entry, and the date passed without them going live | urgent |
| Published without an SEO description | should fix; nice to fix when the entry has an excerpt-like field |
| Published and untouched for longer than your threshold | should fix |
| SEO description too short or too long | nice to fix |
| Draft abandoned for longer than your threshold | nice to fix |

Many sites render a description of their own when the SEO panel is empty,
usually from an excerpt or intro field. An entry with a non-empty `excerpt`,
`description`, `summary`, `intro`, `teaser`, `lead`, `subtitle`, or a field
ending in `_excerpt`, `_description`, `_summary` or `_subheadline` therefore
gets the lower priority, and the finding names the field. A site whose
templates always render a description can switch the check off.

The report holds one row per entry that needs attention, most urgent first.
It shows the current state, not a history: an entry is checked again when it
is published, unpublished, scheduled, unscheduled or restored, and leaves the
report as soon as it is trashed or deleted. Other edits show up with the next
audit, which also removes rows of entries that no longer exist.

Each run audits one page of one collection, and an audit carries on in
follow-up runs until it is done, one per firing of the site's cron trigger,
instead of waiting a day per collection. Every run stays within the ten
subrequests EmDash allows a sandboxed plugin per invocation.

The report and the dashboard widget also warn about routable collections
without a URL pattern. EmDash then links their entries as
`/{collection}/{slug}` in the sitemap and the admin, which is a 404 on any
site whose routes differ, and nothing else says so.

## Trust contract

`content:read` and `schema:read`, nothing else. Every rule is computed from
fields the content and schema APIs already return, so there is **no network
access** and no `content:write` — the plugin reports, it never edits an entry.

## Install

Config-based, on any EmDash site and any plan:

```js
// astro.config.mjs
import contentFreshness from "@eisbachcode/emdash-plugin-content-freshness";

emdash({ plugins: [contentFreshness] });
```

Or under `sandboxed: []` if the site has a sandbox runner configured.

Every collection on the site is audited. The nightly audit is registered the
first time the dashboard or the report is opened, so an install needs no
further step. **Audit now** on the report starts one at the next firing of
the site's cron trigger.

**The site needs a cron trigger.** On Cloudflare that is `"crons"` in
`wrangler.jsonc` plus `scheduled: createScheduledHandler()` on the Worker
entry. Without one, the audit is scheduled and never runs.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Stale after | 12 months | For published entries. |
| Draft forgotten after | 6 months | For drafts. |
| SEO description | 50–160 characters | Outside this range is a low-priority finding. |
| Report entries without an SEO description | on | Off for a site whose templates always render a description. The length check still runs. |
| Entries per run | 50 | At most 100, the most one content query returns. The number of calls per run does not grow with it. |
| Schedule | `0 4 * * *` | A cron expression, in UTC. One the scheduler rejects is not saved. |

## Develop

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## Compatibility

| EmDash | Plugin test suite |
| ------ | ----------------- |
| 0.40.1 | 65 passed |
| 0.40.0 | 65 passed |
| 0.39.1 | 65 passed |
| 0.39.0 | 65 passed |

Declared range: `emdash >=0.39.0`, with no upper bound. The table covers
**every EmDash release since the floor**. 0.39.0 is the floor because the
plugin lists collections through `schema:read`, which earlier versions do not
have.

Reproduce with `scripts/compat-matrix.sh` from the repo root. Last run
2026-09-25, when 0.40.1 was the latest EmDash release. A newer EmDash than the
table's top row is untested rather than unsupported: nothing blocks the install,
and this table is how you tell the difference.

## Licence

MIT © Eisbachcode
