/**
 * Role levels, and the check a Block Kit route needs before it writes.
 *
 * Shared because all three plugins have the same shape: one `admin` route
 * serving a report an editor should see and a settings form only an
 * administrator should submit. A route carries a single permission, so the
 * route declares the lower bar and the handler enforces the higher one on
 * the write.
 */

/**
 * The numbers EmDash stores for each role.
 *
 * `UserInfo.role` on a route context is this number and nothing more: the
 * plugin API types it as `number`, `emdash/plugin` exports the `Permission`
 * type without the `Role` values, and `@emdash-cms/auth` is not a plugin
 * dependency. Adding it to get five constants would inline an auth package
 * into a bundle with a 384 KiB ceiling.
 *
 * Copied from `packages/auth/src/types.ts` rather than guessed. They are
 * persisted in the user record, so they cannot change without a migration.
 */
export const ROLE = {
	SUBSCRIBER: 10,
	CONTRIBUTOR: 20,
	AUTHOR: 30,
	EDITOR: 40,
	ADMIN: 50,
} as const;

export type RoleLevel = (typeof ROLE)[keyof typeof ROLE];

/** What a route context carries about the caller. */
export interface RouteUser {
	role?: number;
}

/**
 * Does the caller hold at least `minimum`?
 *
 * Absent is refused. A public route has no user, and a machine token has no
 * bound user, so `undefined` has to mean no rather than unknown: this guards
 * a write, and the host has already applied the route's own permission
 * before the handler runs.
 */
export function hasRole(user: RouteUser | undefined, minimum: RoleLevel | number): boolean {
	return typeof user?.role === "number" && Number.isFinite(user.role) && user.role >= minimum;
}
