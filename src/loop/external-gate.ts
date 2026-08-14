import { execFileSync } from "node:child_process";

import {
	createExternalGateDigests,
	loadRalphBundle,
	runExternalGate,
	type ExternalGateDigests,
	type ExternalGateHook,
} from "../bundle/index.js";
import { readState, updateState } from "../state.js";
import type { RalphLoopState } from "../types.js";

function currentHead(cwd: string): string | null {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function buildInput(
	bundleRoot: string,
	state: RalphLoopState | null,
	hook: ExternalGateHook,
	digests: ExternalGateDigests,
	extra: {
		promise?: "NEXT" | "COMPLETE";
		resume?: { same_token: boolean; same_session: boolean };
		stopReason?: RalphLoopState["stop_reason"];
	} = {},
) {
	const current = currentHead(bundleRoot);
	return {
		version: 1 as const,
		hook,
		workspace_root: bundleRoot,
		digests,
		heads: {
			start: state?.git_head ?? current,
			current,
			accepted:
				extra.promise || hook === "transition" || hook === "cleanup"
					? current
					: null,
		},
		loop: {
			token: state?.loop_token ?? null,
			iteration: state?.iteration ?? 0,
			max_iterations: state?.max_iterations ?? 0,
			started_at: state?.started_at ?? null,
			session_id: state?.session_id || null,
			stop_reason: extra.stopReason ?? state?.stop_reason ?? null,
		},
		...(extra.promise ? { promise: extra.promise } : {}),
		...(extra.resume ? { resume: extra.resume } : {}),
	};
}

export function validateExternalGateDigests(
	cwd: string,
	state: RalphLoopState,
): string | null {
	try {
		const digests = createExternalGateDigests(loadRalphBundle(cwd));
		if (!digests) return "external gate configuration was removed";
		if (state.external_gate_entrypoint_digest !== digests.entrypoint) {
			return "external gate entrypoint digest drift detected";
		}
		if (state.immutable_bundle_digest !== digests.immutable_bundle) {
			return "immutable Ralph bundle digest drift detected";
		}
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function invokeExternalGate(
	cwd: string,
	state: RalphLoopState | null,
	hook: ExternalGateHook,
	extra: {
		promise?: "NEXT" | "COMPLETE";
		resume?: { same_token: boolean; same_session: boolean };
		stopReason?: RalphLoopState["stop_reason"];
	} = {},
): string | null {
	try {
		const bundle = loadRalphBundle(cwd);
		const digests = createExternalGateDigests(bundle);
		if (!digests) {
			return state?.external_gate_entrypoint_digest
				? "external gate configuration was removed"
				: null;
		}
		if (state?.external_gate_entrypoint_digest) {
			const drift = validateExternalGateDigests(cwd, state);
			if (drift) return drift;
		}
		return runExternalGate(bundle, buildInput(bundle.root, state, hook, digests, extra));
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function dispatchExternalStopInMemory(
	cwd: string,
	state: RalphLoopState,
	stopReason: RalphLoopState["stop_reason"],
): string | null {
	if (!state.external_gate_entrypoint_digest) return null;
	return invokeExternalGate(cwd, state, "stop", { stopReason });
}

export function dispatchExternalStop(
	cwd: string,
	state: RalphLoopState,
	stopReason: RalphLoopState["stop_reason"],
): string | null {
	const durable = readState(cwd) ?? state;
	if (!durable.external_gate_entrypoint_digest || durable.external_gate_stop_dispatched) {
		return null;
	}
	const effectiveReason = durable.external_gate_stop_pending
		? ((durable.external_gate_stop_reason as RalphLoopState["stop_reason"]) ??
			stopReason)
		: stopReason;
	updateState(cwd, {
		external_gate_stop_pending: true,
		external_gate_stop_reason: effectiveReason,
		external_gate_error: null,
	});
	const latest = readState(cwd) ?? durable;
	const failure = invokeExternalGate(cwd, latest, "stop", {
		stopReason: effectiveReason,
	});
	updateState(cwd, {
		external_gate_stop_pending: failure !== null,
		external_gate_stop_dispatched: failure === null,
		external_gate_error: failure,
	});
	return failure;
}

export function reconcileExternalStop(cwd: string): string | null {
	const state = readState(cwd);
	if (!state?.external_gate_stop_pending) return null;
	return dispatchExternalStop(
		cwd,
		state,
		(state.external_gate_stop_reason as RalphLoopState["stop_reason"]) ?? "error",
	);
}

export function resetExternalTerminalState(cwd: string): void {
	updateState(cwd, {
		external_gate_stop_dispatched: false,
		external_gate_stop_pending: false,
		external_gate_stop_reason: null,
		external_gate_cleanup_pending: false,
		external_gate_error: null,
	});
}

export function runTerminalCleanup(
	cwd: string,
	state: RalphLoopState,
): string | null {
	if (!state.external_gate_entrypoint_digest) return null;
	if (state.running || state.stop_reason !== "complete") {
		return "external gate cleanup requires durable COMPLETE state";
	}
	const failure = invokeExternalGate(cwd, state, "cleanup", {
		stopReason: "complete",
	});
	updateState(cwd, {
		external_gate_cleanup_pending: failure !== null,
		external_gate_error: failure,
	});
	return failure;
}

export function retryTerminalCleanup(cwd: string): string | null {
	const state = readState(cwd);
	if (!state?.external_gate_cleanup_pending) return null;
	return runTerminalCleanup(cwd, state);
}
