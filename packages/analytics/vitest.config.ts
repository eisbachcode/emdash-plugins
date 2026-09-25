import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [emdashPluginTest()],
	test: {
		// Most tests run the plugin inside workerd through the test host. The
		// heaviest take about 2.5 s on a fast laptop and passed vitest's 5 s
		// default on shared CI runners. The same limits as upstream's own
		// plugin-test suite.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
