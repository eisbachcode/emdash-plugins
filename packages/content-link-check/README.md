# content-link-check

Scheduled link audit for [EmDash](https://emdashcms.com) content. Finds broken
links, dead domains, redirects and malformed URLs in your entries, and reports
them in the admin.

- Sweeps every collection on a cron schedule in small steps, one per firing
  of the site's cron trigger, until the sweep is done. Each step stays
  within the 10 calls a sandboxed plugin gets per run, and in-process
  within Workers Free's 50 subrequests and 50 D1 queries: it reads a page of
  entries and writes at most 20 rows, or tidies up, or checks about four
  links. A sweep of a few hundred links finishes overnight on a per-minute
  cron trigger; a slower trigger takes proportionally longer. A sweep still
  running at the next scheduled start carries on rather than starting over.
- Checks internal and outbound links in published entries. Internal links are
  requested from the live site rather than resolved from the database, so
  hand-built Astro pages count as well as CMS entries.
- Checks each distinct link once per sweep, however many entries link to it.
  The report lists it once, with the first entry it appears in and how many
  more there are, and shows up to 100 findings at a time.
- Keeps the report in step with the content. Every sweep records what it
  finds and then drops whatever it did not find again, so a link taken out
  of an entry, or an entry unpublished or deleted, leaves the report when
  the next sweep finishes.
- Reports a redirect hop on an internal link instead of following it, because
  that is something EmDash's redirect engine can fix. Outbound links are
  followed and judged by where they end.
- Only a clear failure counts: a 404 or 410, a domain that no longer resolves,
  or a server error that persists. A 401, 403, 429 or any other answer that
  does not show whether the link works is never reported: the link's last
  clear result stands, and a link never clearly checked is counted as
  unresolved. A site that blocks datacentre IPs therefore does not fill the
  report with noise. A host that answers 429 is not asked again, for any
  link, before its `Retry-After`.
- A failure has to repeat and to last before it is reported: 12 hours for a
  404 or a dead domain, 60 hours for a server error, so running two sweeps in a
  row cannot report an unreachable link. A URL that does not parse is reported
  on the repeat alone, since waiting cannot fix it. Once reported, a link stays
  in the report until it works again.
- Reports only. It has no `content:write` capability and never edits an entry.

It does not look for orphaned entries. Navigation usually lives in menus and
templates, which a plugin cannot read, so almost every page would look
unlinked.

## Trust contract

| Capability | Why |
| --- | --- |
| `content:read` | Read entries to find the links in them. |
| `schema:read` | List the collections to sweep. |
| `network:request:unrestricted` | The hosts checked are whatever your editors linked to, so no fixed allow-list can be pinned at publish time. Only `HEAD` and `GET` are issued, no content is sent, and no response body is read. |

## Install

Config-based, on any EmDash site and any plan:

```js
// astro.config.mjs
import contentLinkCheck from "@eisbachcode/emdash-plugin-content-link-check";

emdash({ plugins: [contentLinkCheck] });
```

Or under `sandboxed: []` if the site has a sandbox runner configured. Both
work the same way; see the sweep above for how each run stays within a
sandboxed plugin's allowance.

There is no activation step. A plugin listed in the Astro config is never
"activated" the way one switched on under **Admin → Extensions** is, so the
plugin registers its nightly sweep itself. That happens the first time
someone opens the admin dashboard, the link report or its settings, or saves
or publishes an entry.

**The site needs a cron trigger.** On Cloudflare that is `"crons"` in
`wrangler.jsonc` plus `scheduled: createScheduledHandler()` on the Worker
entry. Without one, the sweep is scheduled and never runs. The sweep advances
one step per firing, so a per-minute trigger (`"* * * * *"`) is the one to
use.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Entries per step | 25 | Entries read per step of a sweep, up to 100. A page that links to more targets than a step may write is read in smaller pieces. It does not change how many links a step checks. |
| Schedule | `0 3 * * *` | Any cron expression. |
| Check outbound links | on | Off restricts the sweep to internal links. |
| Failures before reporting | 2 | Failed checks in a row before a link counts as broken, on top of the 12 or 60 hours above. |

## Develop

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

`pnpm dev` rebuilds on save. To try it against a local site, add the built
package with a `file:` dependency and register it in `plugins: []`.

## Compatibility

| EmDash | Plugin test suite |
| ------ | ----------------- |
| 0.40.1 | 89 passed |
| 0.40.0 | 89 passed |
| 0.39.1 | 89 passed |
| 0.39.0 | 89 passed |

Declared range: `emdash >=0.39.0 <1.0.0`. The table covers **every released
version inside it**, 0.39.0 through 0.40.1, so this is the whole range rather
than a sample. 0.39.0 is the floor because the plugin lists collections through
`schema:read`, which earlier versions do not have.

Reproduce with `scripts/compat-matrix.sh 0.39.0 0.39.1 0.40.0 0.40.1` from the
repo root. Last run 2026-09-26, when 0.40.1 was the latest EmDash release. A newer EmDash than the
table's top row is untested rather than unsupported: nothing blocks the install,
and this table is how you tell the difference.

## Licence

MIT © Eisbachcode
