# EmDash plugins

Plugins for [EmDash](https://github.com/emdash-cms/emdash) by [Eisbachcode](https://eisbachcode.de).

| Package | What it does |
|---|---|
| [`@eisbachcode/emdash-plugin-analytics`](packages/analytics) | Cloudflare Web Analytics on the EmDash dashboard and next to your content: traffic per entry, a setup check, German and English |
| [`@eisbachcode/emdash-plugin-content-freshness`](packages/content-freshness) | A scheduled audit of your content: stale entries, missing SEO descriptions, forgotten drafts, schedules that never fired. Read-only, no network |
| [`@eisbachcode/emdash-plugin-content-link-check`](packages/content-link-check) | A scheduled check of the links in your content: broken links, dead domains and redirects, reported only once they persist. Read-only |

## Development

A pnpm workspace. See [AGENTS.md](AGENTS.md) for conventions and checks.

```sh
pnpm install
pnpm test
```

## Licence

MIT, see [LICENSE](LICENSE).
