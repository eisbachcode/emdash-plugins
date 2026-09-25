# Agent instructions

Before editing this plugin, read `skills/creating-plugins/SKILL.md` completely. Codex discovers the same directory through `.agents/skills`; Claude discovers it through `.claude/skills` and reads these instructions through `.claude/CLAUDE.md`.
Keep `emdash-plugin.jsonc` aligned with the runtime implementation, declare every capability and host the plugin uses, and run the generated validation, typecheck, test, and build scripts after changes.

## Toolchain

`emdash` is a peer with a floor and no ceiling (`>=0.39.0`, the same as
`env:emdash` in the manifest); the dev dependency stays below the next
major until the toolchain is moved on purpose. Built with
`@emdash-cms/plugin-cli@0.12.0`, `@emdash-cms/plugin-test@0.2.0` and
`@emdash-cms/blocks@0.39.0`; `scripts/compat-matrix.sh` at the repository
root runs the suite against later EmDash releases. A plain `pnpm install`
at the workspace root is enough.

## Two builds

`pnpm run build` runs both:

1. `emdash-plugin build` — the sandbox runtime and the descriptor module. Its
   entry is hard-coded to `src/plugin.ts`.
2. `tsdown` — the `./astro` export. It is a separate build on purpose and is
   never part of the registry bundle, which stages only `backend.js`,
   `manifest.json`, the README and images.

## Things that will bite

- **Never widen a provider query window.** `date_geq` older than
  `today − 7` makes Cloudflare serve the whole query from a ~10 % sample,
  quantizing every day in it and dropping quiet days entirely. There are
  three layers guarding this (`syncWindow` clamps, the adapter refuses,
  `decideWrite` will not downgrade). Do not remove one because the other two
  exist.
- **Read before write.** Blind upserts cost roughly 5 D1 rows each and blow
  through the free plan's daily budget at a 15-minute cadence.
- **Count your bridge calls.** A sandboxed invocation gets ten subrequests
  and every `ctx` call spends one, `log` and `cron` included. The sync tick
  alternates phases and Refresh only schedules a tick for exactly this
  reason. `tests/budget.test.ts` counts each invocation's worst case; run it
  after any change that adds a `ctx` call.
- **Block Kit keys are snake_case.** Use the constructors in
  `src/ui/blocks.ts`; the renderer silently ignores camelCase.
- `routeCtx.ui` (locale, direction) reaches the widget and the pages only
  when the plugin runs sandboxed. Registered in `plugins: []` it is
  undefined there, so read `routeCtx.ui?.locale` and fall back to English;
  never return empty blocks when it is missing. The editor panel gets it in
  both modes, with `ui.entry`.
- **MCP schemas never reach the runtime.** `emdash-plugin build` strips
  the `mcp` property of `src/plugin.ts` from the bundle and writes the zod
  schemas into the manifest as JSON Schema. `src/tools/declare.ts` is
  referenced only from there, so zod stays a dev dependency and out of the
  bundle; a schema imported by a route handler would pull it back in. The
  handlers in `src/tools/load.ts` validate by hand, because the routes are
  also reachable over HTTP without the MCP server's validation.
- **An MCP output schema is strict.** Every object becomes
  `additionalProperties: false` and the MCP server rejects an answer that
  does not match, so a loader's result and its declared output have to
  agree key for key. `tests/tools.test.ts` checks each answer against the
  schema the build wrote.
- **MCP tools reach sandboxed installs only.** EmDash's in-process loader
  reads tools from the runtime module, where the build removed them, so a
  `plugins: []` install lists none. Test tools sandboxed.
- **Block Kit keeps no state.** Anything a page needs to remember between
  interactions travels in an `action_id`, a button `value` or a table
  cursor (see `src/ui/content.ts`).
