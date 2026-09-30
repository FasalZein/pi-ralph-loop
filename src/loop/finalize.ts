import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { updateState } from "../state.js";
import type { RalphLoopState } from "../types.js";
import { clearCommandCtx, getCommandCtx } from "./command-context.js";
import { stopLoopHeartbeat } from "./ownership.js";
import { clearPendingSessionReplacement } from "./session-transition.js";
import { clearLoopStatus } from "./status.js";
import { publishConfirmedFact, readStateForTelemetry } from "./watch-events.js";

export function finalizeLoop(
	ctx: ExtensionContext,
	cwd: string,
	stopReason: RalphLoopState["stop_reason"],
	errorCount: number,
): void {
	// Captured before the terminal write so the fact names the run that ends,
	// and only while running so an idempotent re-finalize publishes nothing.
	const captured = readStateForTelemetry(cwd);
	const closingRun = captured?.running ? captured : null;
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
	});
	stopLoopHeartbeat(cwd);
	clearLoopStatus(ctx);
	clearPendingSessionReplacement();
	if (getCommandCtx()?.cwd === cwd) {
		clearCommandCtx();
	}
	if (closingRun) {
		// updateState silently skips its write when it cannot read the state;
		// publish only once the terminal write for this run is observed.
		publishConfirmedFact(
			cwd,
			closingRun,
			{ kind: "loop-ended", reason: stopReason },
			(saved) => !saved.running && saved.stop_reason === stopReason,
		);
	}
}
