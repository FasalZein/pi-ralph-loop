import type { Host, HostHandle } from "./host.js";
import type { DriverExit, DriverRuntime, LaunchMode } from "./driver.js";
import { readStatus, type StatusResult, type StatusRuntime } from "./status.js";

/** Owner decisions on #10. */
export const LAUNCH_READY_TIMEOUT_MS = 30_000;
export const LAUNCH_FACT_TIMEOUT_MS = 30_000;
export const STOP_ACK_TIMEOUT_MS = 15_000;
export type LifecycleRequest =
	| { readonly kind: "launch"; readonly root: string; readonly mode: LaunchMode }
	| { readonly kind: "stop"; readonly root: string; readonly timeoutMs: number | null };
export type LifecycleOutcome = { readonly ok: true; readonly handle: HostHandle | null } | { readonly ok: false; readonly error: string };
export type CommandRuntime = StatusRuntime & {
	readonly host?: Host;
	readonly out?: (line: string) => void;
	readonly err?: (line: string) => void;
	readonly signal?: AbortSignal;
	readonly env?: NodeJS.ProcessEnv;
	/** Role command for the hidden driver; the default runs this package's `ralph _driver`. */
	readonly enforcerArgv?: (manifest: string) => readonly string[];
	readonly driverArgv?: (manifest: string) => readonly string[];
	readonly readyTimeoutMs?: number;
	readonly factTimeoutMs?: number;
	readonly stopAckTimeoutMs?: number;
	readonly pollMs?: number;
};

export type Request = LifecycleRequest | { readonly kind: "status"; readonly root: string };
export type Outcome = LifecycleOutcome | { readonly ok: true; readonly handle: null; readonly status: StatusResult };

/** Status never loads the host or pi lifecycle code. */
export async function execute(request: Request, runtime: CommandRuntime = {}): Promise<Outcome> {
	try {
		if (request.kind === "status") return { ok: true, handle: null, status: await readStatus(request.root, runtime) };
		const lifecycle = await import("./command-lifecycle.js");
		return await lifecycle.execute(request, runtime);
	} catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function runDriverRole(path: string, runtime: DriverRuntime = {}): Promise<DriverExit> {
	return (await import("./command-lifecycle.js")).runDriverRole(path, runtime);
}

export async function runEnforcerRole(path: string, runtime: import("./enforcer-process.js").EnforcementRuntime = {}): Promise<import("./enforcer-process.js").EnforcerExit> {
	return (await import("./command-lifecycle.js")).runEnforcerRole(path, runtime);
}
