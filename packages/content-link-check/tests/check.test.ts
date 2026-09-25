import { createUnrestrictedHttpAccess } from "emdash";
import type { PluginContext } from "emdash/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkUrl, judge, parseRetryAfter, type CheckResult, type Verdict } from "../src/check.js";

const INTERNAL = { outbound: false };
const EXTERNAL = { outbound: true };

describe("checkUrl", () => {
	it.each([
		[200, "ok", null],
		[404, "broken", "not-found"],
		[410, "broken", "not-found"],
		[401, "unknown", "auth"],
		[407, "unknown", "auth"],
		[403, "unknown", "blocked"],
		[451, "unknown", "blocked"],
		[429, "unknown", "rate-limited"],
		[400, "unknown", "unexpected-status"],
		[500, "unknown", "server-error"],
		[503, "unknown", "server-error"],
	])("calls a %i %s", async (status, state, reason) => {
		const ctx = fakeCtx(async () => new Response(null, { status }));
		expect(await checkUrl(ctx, "https://target.test/x", EXTERNAL)).toMatchObject({ state, reason, status });
	});

	it("retries an outbound link with GET when HEAD fails", async () => {
		const calls: string[] = [];
		const ctx = fakeCtx(async (_url, init) => {
			calls.push(String(init?.method));
			return new Response(null, { status: calls.length === 1 ? 403 : 200 });
		});

		const result = await checkUrl(ctx, "https://target.test/x", EXTERNAL);
		expect(calls).toEqual(["HEAD", "GET"]);
		expect(result).toMatchObject({ state: "ok", requests: 2 });
	});

	it("does not send a GET when HEAD succeeds", async () => {
		const calls: string[] = [];
		const ctx = fakeCtx(async (_url, init) => {
			calls.push(String(init?.method));
			return new Response(null, { status: 200 });
		});

		const result = await checkUrl(ctx, "https://target.test/x", EXTERNAL);
		expect(calls).toEqual(["HEAD"]);
		expect(result.requests).toBe(1);
	});

	it("charges three subrequests a request, and a followed redirect at its worst", async () => {
		const plain = fakeCtx(async () => new Response(null, { status: 200 }));
		expect((await checkUrl(plain, "https://target.test/x", EXTERNAL)).outbound).toBe(3);

		const refusedHead = fakeCtx(async (_url, init) => new Response(null, { status: init?.method === "HEAD" ? 403 : 200 }));
		expect((await checkUrl(refusedHead, "https://target.test/x", EXTERNAL)).outbound).toBe(6);

		const followed = fakeCtx(async () => landed(new Response(null, { status: 200 }), "https://elsewhere.test/"));
		expect((await checkUrl(followed, "https://target.test/x", EXTERNAL)).outbound).toBe(18);

		const failing = fakeCtx(async () => {
			throw new Error("connection reset");
		});
		expect((await checkUrl(failing, "https://target.test/x", EXTERNAL)).outbound).toBe(18);
		expect((await checkUrl(failing, "https://example.test/page", INTERNAL)).outbound).toBe(3);
	});

	it("does not ask a rate-limited host again with GET", async () => {
		const calls: string[] = [];
		const ctx = fakeCtx(async (_url, init) => {
			calls.push(String(init?.method));
			return new Response(null, { status: 429 });
		});

		await checkUrl(ctx, "https://target.test/x", EXTERNAL);
		expect(calls).toEqual(["HEAD"]);
	});

	it("retries an internal link with GET only when HEAD is refused", async () => {
		const methodsFor = async (status: number) => {
			const calls: string[] = [];
			const ctx = fakeCtx(async (_url, init) => {
				calls.push(String(init?.method));
				return new Response(null, { status: calls.length === 1 ? status : 200 });
			});
			await checkUrl(ctx, "https://example.test/page", INTERNAL);
			return calls;
		};

		expect(await methodsFor(404)).toEqual(["HEAD"]);
		expect(await methodsFor(405)).toEqual(["HEAD", "GET"]);
	});

	it("keeps where an outbound link landed when HEAD redirected and GET finished the check", async () => {
		const requested: string[] = [];
		const ctx = fakeCtx(async (url, init) => {
			requested.push(`${String(init?.method)} ${url}`);
			return init?.method === "HEAD"
				? landed(new Response(null, { status: 405 }), "https://b.test/y")
				: new Response(null, { status: 200 });
		});

		const result = await checkUrl(ctx, "http://a.test/x", EXTERNAL);
		expect(requested).toEqual(["HEAD http://a.test/x", "GET https://b.test/y"]);
		expect(result).toMatchObject({ state: "ok", finalUrl: "https://b.test/y" });
	});

	it("reports an internal redirect hop instead of following it", async () => {
		const ctx = fakeCtx(
			async () => new Response(null, { status: 301, headers: { location: "https://target.test/new" } }),
		);
		const result = await checkUrl(ctx, "https://target.test/old", INTERNAL);
		expect(result).toMatchObject({ state: "redirect", status: 301, location: "https://target.test/new" });
	});

	it("keeps the time a rate-limited target asked for", async () => {
		const ctx = fakeCtx(async () => new Response(null, { status: 429, headers: { "retry-after": "3600" } }));
		const before = Date.now();
		const result = await checkUrl(ctx, "https://target.test/x", EXTERNAL);
		const retryAt = Date.parse(result.retryAfter ?? "");
		expect(retryAt).toBeGreaterThanOrEqual(before + 3600_000);
		expect(retryAt).toBeLessThanOrEqual(Date.now() + 3600_000);
	});

	it("turns a network error into an unresolved result", async () => {
		const ctx = fakeCtx(async () => {
			throw new Error("dns failure");
		});
		const result = await checkUrl(ctx, "https://target.test/x", EXTERNAL);
		expect(result).toMatchObject({ state: "unknown", reason: "network-error", error: "dns failure" });
	});

	it("recognises the sandbox bridge's redirect limit", async () => {
		const ctx = fakeCtx(async () => {
			throw new Error("Too many redirects (max 5)");
		});
		const result = await checkUrl(ctx, "https://target.test/x", EXTERNAL);
		expect(result).toMatchObject({ state: "unknown", reason: "too-many-redirects" });
	});

	describe("through emdash's own guarded fetch", () => {
		// emdash resolves every target over DNS-over-HTTPS before it fetches,
		// with the global fetch, and follows redirects itself. Stubbing the DNS
		// answer runs the real guard and redirect loop, so a changed upstream
		// error message or redirect behaviour fails here instead of in
		// production.
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		function stubDns(status: number, address?: string) {
			vi.stubGlobal("fetch", async (input: string | URL | Request) => {
				const type = new URL(input instanceof Request ? input.url : String(input)).searchParams.get("type");
				const answer = address && type === "A" ? [{ type: 1, data: address }] : [];
				return Response.json({ Status: status, Answer: answer });
			});
		}

		function guardedCtx(targets: Record<string, () => Response>) {
			const http = createUnrestrictedHttpAccess("content-link-check", async (input) => {
				const url = input instanceof Request ? input.url : String(input);
				const target = targets[url];
				if (!target) throw new Error(`unexpected request to ${url}`);
				return target();
			});
			return { http } as unknown as PluginContext;
		}

		it("reports a domain that no longer exists as broken", async () => {
			stubDns(3);
			const result = await checkUrl(guardedCtx({}), "https://gone.test/page", EXTERNAL);
			expect(result).toMatchObject({ state: "broken", reason: "dead-domain" });
		});

		it("leaves a failed DNS lookup unresolved", async () => {
			stubDns(2);
			const result = await checkUrl(guardedCtx({}), "https://flaky.test/page", EXTERNAL);
			expect(result.state).toBe("unknown");
		});

		it("judges an outbound link by where its redirects end", async () => {
			stubDns(0, "93.184.216.34");
			const ctx = guardedCtx({
				"https://old.test/": () => new Response(null, { status: 301, headers: { location: "https://new.test/" } }),
				"https://new.test/": () => new Response(null, { status: 200 }),
			});
			const result = await checkUrl(ctx, "https://old.test/", EXTERNAL);
			expect(result).toMatchObject({ state: "ok", finalUrl: "https://new.test/" });
		});

		it("calls an outbound link broken when its redirect ends in a 404", async () => {
			stubDns(0, "93.184.216.34");
			const ctx = guardedCtx({
				"https://old.test/": () => new Response(null, { status: 301, headers: { location: "https://new.test/" } }),
				"https://new.test/": () => new Response(null, { status: 404 }),
			});
			const result = await checkUrl(ctx, "https://old.test/", EXTERNAL);
			expect(result).toMatchObject({ state: "broken", reason: "not-found" });
		});

		it("leaves an endless redirect unresolved", async () => {
			stubDns(0, "93.184.216.34");
			const ctx = guardedCtx({
				"https://loop.test/a": () => new Response(null, { status: 302, headers: { location: "/b" } }),
				"https://loop.test/b": () => new Response(null, { status: 302, headers: { location: "/a" } }),
			});
			const result = await checkUrl(ctx, "https://loop.test/a", EXTERNAL);
			expect(result).toMatchObject({ state: "unknown", reason: "too-many-redirects" });
		});
	});

	it("rejects non-http schemes without a request", async () => {
		let called = false;
		const ctx = fakeCtx(async () => {
			called = true;
			return new Response(null, { status: 200 });
		});
		const result = await checkUrl(ctx, "mailto:hi@example.com", EXTERNAL);
		expect(result.state).toBe("malformed");
		expect(called).toBe(false);
	});

	it("is unresolved rather than broken without the network capability", async () => {
		const ctx = { http: undefined } as unknown as PluginContext;
		expect((await checkUrl(ctx, "https://target.test/x", EXTERNAL)).state).toBe("unknown");
	});
});

describe("parseRetryAfter", () => {
	const now = Date.parse("2026-09-25T12:00:00.000Z");

	it("reads delay-seconds and HTTP dates", () => {
		expect(parseRetryAfter("120", now)).toBe("2026-09-25T12:02:00.000Z");
		expect(parseRetryAfter("Fri, 25 Sep 2026 14:00:00 GMT", now)).toBe("2026-09-25T14:00:00.000Z");
	});

	it("holds the wait between a minute and a week", () => {
		expect(parseRetryAfter("0", now)).toBe("2026-09-25T12:01:00.000Z");
		expect(parseRetryAfter("99999999", now)).toBe("2026-10-02T12:00:00.000Z");
	});

	it("ignores a value it cannot read", () => {
		expect(parseRetryAfter("soon", now)).toBeNull();
		expect(parseRetryAfter(null, now)).toBeNull();
	});
});

describe("judge", () => {
	const THRESHOLD = 2;
	const start = new Date("2026-09-25T03:00:00.000Z");
	const hoursLater = (hours: number) => new Date(start.getTime() + hours * 3_600_000);

	/** Fold a series of checks, made at the given times, into one verdict. */
	function run(checks: Array<[CheckResult, Date]>): Verdict {
		let verdict: Verdict | null = null;
		for (const [result, at] of checks) verdict = judge(verdict, result, at, THRESHOLD);
		if (!verdict) throw new Error("no checks");
		return verdict;
	}

	it("does not report a 404 found twice within minutes", () => {
		const verdict = run([
			[notFound, start],
			[notFound, new Date(start.getTime() + 60_000)],
		]);
		expect(verdict).toMatchObject({ state: "broken", consecutiveFailures: 2, reported: false });
	});

	it("reports a 404 on the second nightly sweep", () => {
		expect(
			run([
				[notFound, start],
				[notFound, hoursLater(24)],
			]).reported,
		).toBe(true);
	});

	it("reports a server error only once it has lasted, and only then calls it broken", () => {
		const threeNights: Array<[CheckResult, Date]> = [
			[serverError, start],
			[serverError, hoursLater(24)],
			[serverError, hoursLater(48)],
		];
		expect(run(threeNights)).toMatchObject({ state: "unknown", reported: false });
		expect(run([...threeNights, [serverError, hoursLater(72)]])).toMatchObject({ state: "broken", reported: true });
	});

	it("lets the last verdict stand on an answer that shows nothing", () => {
		const verdict = run([
			[notFound, start],
			[blocked, hoursLater(24)],
		]);
		expect(verdict).toMatchObject({
			state: "broken",
			consecutiveFailures: 1,
			firstFailedAt: start.toISOString(),
			reported: false,
			conclusive: false,
		});

		const resumed = run([
			[notFound, start],
			[blocked, hoursLater(24)],
			[notFound, hoursLater(48)],
		]);
		expect(resumed.reported).toBe(true);
	});

	it("calls a first check that shows nothing unresolved", () => {
		expect(run([[blocked, start]])).toMatchObject({ state: "unknown", reported: false, conclusive: true });
	});

	it("keeps a reported link reported through an answer that shows nothing", () => {
		const verdict = run([
			[notFound, start],
			[notFound, hoursLater(24)],
			[blocked, hoursLater(48)],
		]);
		expect(verdict).toMatchObject({ state: "broken", reported: true });
	});

	it("keeps a reported 404 reported when its server starts failing", () => {
		const verdict = run([
			[notFound, start],
			[notFound, hoursLater(24)],
			[serverError, hoursLater(48)],
		]);
		expect(verdict).toMatchObject({ state: "broken", reported: true });
	});

	it("clears the failure run when the link works again", () => {
		const verdict = run([
			[notFound, start],
			[ok, hoursLater(24)],
		]);
		expect(verdict).toMatchObject({ state: "ok", consecutiveFailures: 0, firstFailedAt: null });
	});
});

const ok: CheckResult = {
	state: "ok",
	reason: null,
	status: 200,
	location: null,
	finalUrl: null,
	retryAfter: null,
	error: null,
	requests: 1,
	outbound: 3,
};
const notFound: CheckResult = { ...ok, state: "broken", reason: "not-found", status: 404 };
const serverError: CheckResult = { ...ok, state: "unknown", reason: "server-error", status: 503 };
const blocked: CheckResult = { ...ok, state: "unknown", reason: "blocked", status: 403 };

/** A response as emdash hands it back after following redirects to `url`. */
function landed(response: Response, url: string): Response {
	Object.defineProperties(response, { url: { value: url }, redirected: { value: true } });
	return response;
}

function fakeCtx(fetch: (url: string, init?: RequestInit) => Promise<Response>) {
	return { http: { fetch } } as unknown as PluginContext;
}
