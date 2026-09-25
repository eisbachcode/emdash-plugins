# Agent instructions

Before editing this plugin, read `skills/creating-plugins/SKILL.md` completely. Codex discovers the same directory through `.agents/skills`; Claude discovers it through `.claude/skills` and reads these instructions through `.claude/CLAUDE.md`.
Keep `emdash-plugin.jsonc` aligned with the runtime implementation, declare every capability and host the plugin uses, and run the generated validation, typecheck, test, and build scripts after changes.

## Toolchain

`emdash` is a peer with a floor and no ceiling (`>=0.39.0`, the same as
`env:emdash` in the manifest); the dev dependency stays below the next
major until the toolchain is moved on purpose. Built with
`@emdash-cms/plugin-cli@0.12.0` and `@emdash-cms/plugin-test@0.2.3` (EmDash 0.40.1);
`scripts/compat-matrix.sh` at the repository root runs the suite against
later EmDash releases. A plain `pnpm install` at the workspace root is
enough.
