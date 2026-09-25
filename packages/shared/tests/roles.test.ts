import { describe, expect, it } from "vitest";

import { hasRole, ROLE } from "../src/roles.js";

describe("hasRole", () => {
	it("admits the exact role and everything above it", () => {
		expect(hasRole({ role: ROLE.ADMIN }, ROLE.ADMIN)).toBe(true);
		expect(hasRole({ role: ROLE.EDITOR }, ROLE.EDITOR)).toBe(true);
		expect(hasRole({ role: ROLE.ADMIN }, ROLE.EDITOR)).toBe(true);
	});

	it("refuses everything below it", () => {
		expect(hasRole({ role: ROLE.EDITOR }, ROLE.ADMIN)).toBe(false);
		expect(hasRole({ role: ROLE.AUTHOR }, ROLE.EDITOR)).toBe(false);
		expect(hasRole({ role: ROLE.SUBSCRIBER }, ROLE.CONTRIBUTOR)).toBe(false);
	});

	it("refuses an absent user rather than treating it as unknown", () => {
		// A public route has no user and a machine token has no bound user.
		// This guards a write, so absent has to mean no.
		expect(hasRole(undefined, ROLE.ADMIN)).toBe(false);
		expect(hasRole({}, ROLE.ADMIN)).toBe(false);
	});

	it("refuses a role that is not a usable number", () => {
		expect(hasRole({ role: Number.NaN }, ROLE.SUBSCRIBER)).toBe(false);
		expect(hasRole({ role: "50" as unknown as number }, ROLE.ADMIN)).toBe(false);
	});

	it("orders the levels the way EmDash does", () => {
		// Guards against a transcription slip: the order is what every
		// comparison above depends on.
		expect([ROLE.SUBSCRIBER, ROLE.CONTRIBUTOR, ROLE.AUTHOR, ROLE.EDITOR, ROLE.ADMIN]).toEqual([10, 20, 30, 40, 50]);
	});
});
