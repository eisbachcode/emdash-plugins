/**
 * Second build: the Astro integration.
 *
 * `emdash-plugin build` has a hard-coded entry of `src/plugin.ts` and
 * produces the sandbox runtime plus the descriptor module. It knows nothing
 * about the `./astro` export, and the registry bundle deliberately stages
 * only `backend.js`, `manifest.json`, the README and images — so the
 * integration has to be built separately and is never part of the bundle a
 * sandboxed install downloads.
 *
 * `platform: "neutral"` because this file runs inside a consumer's Astro
 * build, which may be Node, Bun or a Workers-targeted build.
 */
import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/astro/index.ts"],
	outDir: "dist/astro",
	format: ["esm"],
	outExtensions: () => ({ js: ".mjs" }),
	platform: "neutral",
	dts: true,
	treeshake: true,
	clean: false,
});
