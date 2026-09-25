import { ROLE } from "@eisbachcode/emdash-plugin-shared";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * emdash validates every Block Kit response before the admin sees it, and
 * rejects the whole page for one malformed block. Going through the real
 * route is the only way to catch that.
 */

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

const admin = { id: "u1", email: "admin@example.test", name: null, role: ROLE.ADMIN, createdAt: "2026-01-01" };

async function load(runtime: PluginRuntimeTestHost, page: string): Promise<Array<Record<string, unknown>>> {
	const response = await runtime.actions.routes.request("admin", {
		method: "POST",
		headers: { "x-emdash-request": "1" },
		body: { type: "page_load", page },
		user: admin,
	});
	const body = (await response.json()) as { data?: { blocks?: unknown }; error?: { code: string } };
	if (!Array.isArray(body.data?.blocks)) throw new Error(`${page} was rejected: ${JSON.stringify(body.error)}`);
	return body.data.blocks as Array<Record<string, unknown>>;
}

describe("the admin surfaces", () => {
	it("are accepted by emdash once there are results to show", async () => {
		host = await createPluginRuntimeTestHost();
		await host.fixtures.site({ url: "https://example.test" });
		await host.fixtures.collection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "cta_url", label: "Call to action", type: "string" }],
		});
		await host.fixtures.content("posts", { slug: "post", data: { cta_url: "/old-page" }, status: "published" });
		await host.http.respond(
			"https://example.test/old-page",
			new Response(null, { status: 301, headers: { location: "/new-page" } }),
		);

		const night = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
		host.scheduled.setTime(`${night}T02:59:00.000Z`);
		await host.actions.plugin.activate();
		host.scheduled.setTime(`${night}T03:00:05.000Z`);
		for (let runs = 0; runs < 20; runs++) {
			if ((await host.scheduled.run()).processed === 0) break;
		}

		for (const page of ["widget:summary", "/report", "/settings"]) {
			const blocks = await load(host, page);
			expect(blocks.length).toBeGreaterThan(0);
		}
		expect((await load(host, "widget:summary")).some((block) => block.type === "stats")).toBe(true);
	});
});

describe("a plugin listed in the Astro config", () => {
	// emdash never fires `plugin:activate` for it, so nothing here calls
	// `actions.plugin.activate()`.
	it("gets its nightly sweep from the first admin page load", async () => {
		host = await createPluginRuntimeTestHost();
		await host.fixtures.site({ url: "https://example.test" });
		await host.fixtures.collection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "cta_url", label: "Call to action", type: "string" }],
		});
		await host.fixtures.content("posts", { slug: "post", data: { cta_url: "/page" }, status: "published" });
		await host.http.respond("https://example.test/page", new Response(null, { status: 200 }));

		const night = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
		host.scheduled.setTime(`${night}T02:59:00.000Z`);
		await load(host, "widget:summary");
		host.scheduled.setTime(`${night}T03:00:05.000Z`);
		for (let runs = 0; runs < 20; runs++) {
			if ((await host.scheduled.run()).processed === 0) break;
		}

		expect(await host.inspect.storage.list("checks")).toHaveLength(1);
	});

	it("gets its nightly sweep from a content change, with no admin page opened", async () => {
		host = await createPluginRuntimeTestHost();
		await host.fixtures.site({ url: "https://example.test" });
		await host.fixtures.collection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "cta_url", label: "Call to action", type: "string" }],
		});
		const post = await host.fixtures.content("posts", { slug: "post", data: { cta_url: "/page" }, status: "draft" });
		await host.http.respond("https://example.test/page", new Response(null, { status: 200 }));

		const night = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
		host.scheduled.setTime(`${night}T02:59:00.000Z`);
		await host.actions.content.publish("posts", post.id);
		// Content hooks run deferred, after the action has answered.
		await vi.waitFor(async () => expect(await host?.inspect.scheduledTasks()).not.toEqual([]));
		host.scheduled.setTime(`${night}T03:00:05.000Z`);
		for (let runs = 0; runs < 20; runs++) {
			if ((await host.scheduled.run()).processed === 0) break;
		}

		expect(await host.inspect.storage.list("checks")).toHaveLength(1);
	});
});
