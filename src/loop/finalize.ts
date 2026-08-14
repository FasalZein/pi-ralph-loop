import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { readState, updateState } from "../state.js";
import type { RalphLoopState } from "../types.js";
import { clearCommandCtx, getCommandCtx } from "./command-context.js";
import { dispatchExternalStop, runTerminalCleanup } from "./external-gate.js";
import { stopLoopHeartbeat } from "./ownership.js";
import { clearLoopStatus } from "./status.js";

export function finalizeLoop(
	ctx: ExtensionContext,
	cwd: string,
	stopReason: RalphLoopState["stop_reason"],
	errorCount: number,
): void {
	const state = readState(cwd);
	const stopFailure =
		state && stopReason !== "complete"
			? dispatchExternalStop(cwd, state, stopReason)
			: null;
	updateState(cwd, {
		running: false,
		completed_at: new Date().toISOString(),
		stop_reason: stopReason,
		error_count: errorCount,
		owner_pid: null,
		owner_heartbeat_at: null,
		transitioning: false,
		cancel_requested: false,
		stop_requested: false,
		external_gate_cleanup_pending: Boolean(
			stopReason === "complete" && state?.external_gate_entrypoint_digest,
		),
		external_gate_error: stopFailure,
	});
	const durable = readState(cwd);
	if (durable?.external_gate_cleanup_pending) runTerminalCleanup(cwd, durable);
	stopLoopHeartbeat(cwd);
	clearLoopStatus(ctx);
	if (getCommandCtx()?.cwd === cwd) {
		clearCommandCtx();
	}
}
