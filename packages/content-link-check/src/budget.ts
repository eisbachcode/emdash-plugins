/**
 * The work one invocation may do, in the three units that run out.
 *
 * - **Bridge calls.** A sandboxed plugin gets `BRIDGE_BUDGET` per
 *   invocation: every `ctx.content`, `ctx.storage`, `ctx.kv`, `ctx.cron`,
 *   `ctx.log` and `ctx.http` call is one, and emdash aborts the invocation
 *   on the next.
 * - **D1 queries.** In-process on Workers Free an invocation may make 50,
 *   emdash's own cron bookkeeping included. Most calls are one query, a
 *   content page is about three, and `putMany` is one per row.
 * - **Outbound subrequests.** Also 50 in-process on Workers Free. emdash
 *   resolves every request's host over DNS-over-HTTPS first, A and AAAA, so
 *   a request is three.
 *
 * The plugin cannot tell whether it runs sandboxed, so every invocation
 * stays inside all three. Phases draw from one `Budget` rather than counting
 * for themselves, so a larger allowance only needs its number changed.
 */
export const BRIDGE_BUDGET = 10;
export const QUERY_BUDGET = 35;
export const OUTBOUND_BUDGET = 45;

/** D1 queries of each kind of call, where it is more than one. */
export const QUERIES = {
	contentPage: 3,
	cronSchedule: 2,
	listCollections: 2,
} as const;

export class Budget {
	private calls = 0;
	private queries = 0;
	private outbound = 0;

	/** Bridge calls still available. */
	get left(): number {
		return BRIDGE_BUDGET - this.calls;
	}

	/** D1 queries still available. */
	get queriesLeft(): number {
		return QUERY_BUDGET - this.queries;
	}

	/** Outbound subrequests still available. */
	get outboundLeft(): number {
		return OUTBOUND_BUDGET - this.outbound;
	}

	/**
	 * Record bridge calls and the D1 queries behind them, made or set aside
	 * for calls the invocation will make last.
	 */
	spend(calls = 1, queries = calls): void {
		this.calls += calls;
		this.queries += queries;
	}

	spendOutbound(subrequests: number): void {
		this.outbound += subrequests;
	}
}
