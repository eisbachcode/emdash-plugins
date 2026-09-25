# content-freshness

Scheduled freshness audit for [EmDash](https://emdashcms.com) content. Finds the
entries that quietly went stale and puts them in one list in the admin.

What it looks for:

| Finding | Priority |
| --- | --- |
| Scheduled to publish, the date passed, still not published | urgent |
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

A fixed entry drops out of the report on the next sweep — the audit stores the
current state, not a history.

Each run audits one page of one collection, and an audit carries on in
follow-up runs until it is done, one per firing of the site's cron trigger,
instead of waiting a day per collection.

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

Then activate it once under **Admin → Extensions**. Every collection on the
site is audited.

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
| Entries per run | 50 | One collection list, one `content.list` and two batched storage calls per run, whatever the page size. |
| Schedule | `0 4 * * *` | Any cron expression. |

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
| 0.39.1 | 38 passed |
| 0.39.0 | 38 passed |

Declared range: `emdash >=0.39.0 <1.0.0`. The table covers **every released
version inside it** — 0.39.0 and 0.39.1 are the only ones published, so this is
the whole range rather than a sample. 0.39.0 is the floor because the plugin
lists collections through `schema:read`, which earlier versions do not have.

Reproduce with `scripts/compat-matrix.sh` from the repo root. Last run
2026-09-24, when 0.39.1 was the latest EmDash release. A newer EmDash than the
table's top row is untested rather than unsupported: nothing blocks the install,
and this table is how you tell the difference.

## Licence

MIT © Eisbachcode
