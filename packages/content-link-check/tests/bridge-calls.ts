import { PluginBridge } from "@emdash-cms/plugin-test/worker";

/**
 * The bridge calls a sandboxed invocation makes.
 *
 * On Cloudflare every `ctx` call crosses the bridge as one subrequest, and
 * EmDash gives a sandboxed invocation ten; the eleventh aborts it. The
 * local harness enforces no limit, so this wraps the class those calls
 * land on, the harness's own `PluginBridge`. workerd constructs a fresh
 * entrypoint instance for every incoming RPC call, so the first method
 * that runs on an instance is the call; later ones on the same instance
 * are the bridge using its own helpers.
 */

const calls: string[] = [];
/** For each call, the longest array it was given: ids for getMany/deleteMany, rows for putMany. */
const sizes: number[] = [];
const seen = new WeakSet<object>();
const failing = new Set<string>();
let installed = false;

function install(): void {
	if (installed) return;
	installed = true;
	const proto = PluginBridge.prototype as unknown as Record<string, unknown>;
	for (const name of Object.getOwnPropertyNames(proto)) {
		const original = Object.getOwnPropertyDescriptor(proto, name)?.value;
		if (name === "constructor" || typeof original !== "function") continue;
		proto[name] = function (this: object, ...args: unknown[]) {
			if (!seen.has(this)) {
				seen.add(this);
				calls.push(name);
				sizes.push(Math.max(0, ...args.map((arg) => (Array.isArray(arg) ? arg.length : 0))));
				if (failing.delete(name)) return Promise.reject(new Error(`${name} failed (test)`));
			}
			return (original as (...a: unknown[]) => unknown).apply(this, args);
		};
	}
}

/** Run one invocation and return the bridge calls it made, in order. */
export async function bridgeCalls(invocation: () => Promise<unknown>): Promise<string[]> {
	return (await bridgeCallsWithSizes(invocation)).map(({ name }) => name);
}

/** As `bridgeCalls`, with the longest array each call was given. */
export async function bridgeCallsWithSizes(
	invocation: () => Promise<unknown>,
): Promise<Array<{ name: string; size: number }>> {
	install();
	calls.length = 0;
	sizes.length = 0;
	await invocation();
	return calls.map((name, i) => ({ name, size: sizes[i] ?? 0 }));
}

/**
 * Make the next call to a bridge method fail, as a lost subrequest would.
 *
 * The harness's RPC wrapper also prints the rejection as an uncaught
 * exception. The plugin still receives it; the test run is unaffected.
 */
export function failNextCall(method: string): void {
	install();
	failing.add(method);
}
