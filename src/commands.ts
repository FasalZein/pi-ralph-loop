import { readFileSync } from "node:fs";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
	createExternalGateDigests,
	loadRalphBundle,
} from "./bundle/index.js";
import {
	invokeExternalGate,
	reconcileExternalStop,
	resetExternalTerminalState,
	retryTerminalCleanup,
	validateExternalGateDigests,
} from "./loop/external-gate.js";
import {
	captureDryRunSnapshot,
	compareDryRunSnapshots,
} from "./loop/dry-run.js";
import { finalizeLoop } from "./loop/finalize.js";
import { isLoopOwnerActive } from "./loop/ownership.js";
import { resumeCurrentSession, runLoop } from "./loop-engine.js";
import { parseArgs } from "./parser.js";
import { getTaskBody, readState, updateState } from "./state.js";

const MAX_ITERATION_SUGGESTIONS = [5, 10, 20, 50, 100] as const;
const MS_PER_SECOND = 1000;

type SavedLoop = {
	state: NonNullable<ReturnType<typeof readState>>;
	task: string;
};

function parseResumeArgs(args: string): { force: boolean } | null {
	const trimmed = args.trim();
	if (!trimmed) return { force: false };
	if (trimmed === "--force") return { force: true };
	return null;
}

function isLoopRunning(cwd: string): boolean {
	return readState(cwd)?.running === true;
}

function notifyLoopAlreadyRunning(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("A Ralph loop is already running", "error");
}

function ensureLoopNotRunning(ctx: ExtensionCommandContext): boolean {
	const state = readState(ctx.cwd);
	if (!state?.running) return true;

	if (!isLoopOwnerActive(state, ctx.sessionManager.getSessionId())) {
		finalizeLoop(
			ctx,
			ctx.cwd,
			state.transitioning ? "interrupted" : "error",
			state.error_count,
		);
		ctx.ui.notify("Recovered stale Ralph loop owner before continuing", "warning");
		return true;
	}

	notifyLoopAlreadyRunning(ctx);
	return false;
}

function reconcileTerminalBeforeNewToken(
	ctx: ExtensionCommandContext,
): boolean {
	const stopFailure = reconcileExternalStop(ctx.cwd);
	if (stopFailure) {
		ctx.ui.notify(stopFailure, "error");
		return false;
	}
	const state = readState(ctx.cwd);
	if (!state?.external_gate_cleanup_pending) return true;
	const cleanupFailure = retryTerminalCleanup(ctx.cwd);
	ctx.ui.notify(
		cleanupFailure ?? "Ralph external gate terminal cleanup recovered",
		cleanupFailure ? "error" : "info",
	);
	return cleanupFailure === null;
}

function normalizeBundlePromptReference(task: string): string | null {
	const trimmed = task.trim();
	if (!trimmed.startsWith("@")) return null;

	const reference = trimmed.slice(1);
	const normalized = path.posix.normalize(reference.replaceAll("\\", "/"));
	return normalized === ".ralph/prompt.md" ? normalized : null;
}

function getLoopArgumentCompletions(prefix: string) {
	if (prefix.includes("--max-iterations")) return null;

	const items = MAX_ITERATION_SUGGESTIONS.map(
		(value) => `--max-iterations=${value}`,
	)
		.filter((value) => value.startsWith(prefix) || !prefix)
		.map((value) => ({ value, label: value }));

	return items.length > 0 ? items : null;
}

function readSavedLoop(cwd: string): SavedLoop | null {
	const state = readState(cwd);
	const task = getTaskBody(cwd);
	if (!state || !task) return null;
	return { state, task };
}

function formatResumeNotification(
	state: SavedLoop["state"],
	reuseCurrentSession: boolean,
): string {
	return reuseCurrentSession
		? `Resuming Ralph loop in current session from iteration ${state.iteration}/${state.max_iterations}`
		: `Resuming Ralph loop from iteration ${state.iteration}/${state.max_iterations} in a fresh session`;
}

function getSavedModelState(state: SavedLoop["state"]) {
	return {
		model_provider: state.model_provider,
		model_id: state.model_id,
		thinking_level: state.thinking_level,
	};
}

function formatStatusMessage(state: SavedLoop["state"]): string {
	const elapsed = state.started_at
		? Math.round(
				(Date.now() - new Date(state.started_at).getTime()) / MS_PER_SECOND,
			)
		: 0;

	return [
		`Ralph loop: iteration ${state.iteration}/${state.max_iterations}`,
		`   Started: ${state.started_at}`,
		`   Elapsed: ${elapsed}s`,
		`   Errors: ${state.error_count}`,
		`   Session: ${state.session_id || "unknown"}`,
		`   Transitioning: ${state.transitioning ? "yes" : "no"}`,
	].join("\n");
}

async function handleLoopCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const parsed = parseArgs(args);
	if (!parsed) {
		ctx.ui.notify(
			'Usage: /ralph-loop "task text" [--max-iterations=N] [--dry-run]',
			"error",
		);
		return;
	}
	if (parsed.dryRun) {
		if (isLoopRunning(ctx.cwd)) {
			notifyLoopAlreadyRunning(ctx);
			return;
		}
	} else if (!ensureLoopNotRunning(ctx) || !reconcileTerminalBeforeNewToken(ctx)) {
		return;
	}

	let task = parsed.task;
	const bundleMode = normalizeBundlePromptReference(task) !== null;
	let bundle: ReturnType<typeof loadRalphBundle> | null = null;
	if (bundleMode) {
		try {
			bundle = loadRalphBundle(ctx.cwd);
			task = readFileSync(bundle.files[".ralph/prompt.md"], "utf8");
			if (bundle.items.runtime_contract?.external_gate) {
				if (parsed.maxIterations !== 2 * bundle.items.items.length + 4) {
					throw new Error(
						`Invalid Ralph bundle: external gate requires --max-iterations=${2 * bundle.items.items.length + 4}`,
					);
				}
				createExternalGateDigests(bundle);
			}
		} catch (err) {
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			return;
		}
	}

	if (parsed.dryRun) {
		if (!bundle?.items.runtime_contract?.external_gate) {
			ctx.ui.notify("Ralph dry-run requires a bundle external_gate", "error");
			return;
		}
		if (readState(ctx.cwd)?.external_gate_cleanup_pending) {
			ctx.ui.notify("Ralph terminal cleanup is pending", "error");
			return;
		}
		const before = captureDryRunSnapshot(ctx);
		const gateFailure = invokeExternalGate(ctx.cwd, null, "dry-run", {
			maxIterations: parsed.maxIterations,
		});
		const mutationFailure = compareDryRunSnapshots(
			before,
			captureDryRunSnapshot(ctx),
		);
		const failure = gateFailure ?? mutationFailure;
		ctx.ui.notify(
			failure ?? "Ralph external gate dry-run passed",
			failure ? "error" : "info",
		);
		return;
	}

	await runLoop(pi, ctx, task, parsed.maxIterations, { bundleMode });
}

async function handleResumeCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!ensureLoopNotRunning(ctx)) return;

	const parsedArgs = parseResumeArgs(args);
	if (!parsedArgs) {
		ctx.ui.notify("Usage: /ralph-resume [--force]", "error");
		return;
	}

	const savedLoop = readSavedLoop(ctx.cwd);
	if (!savedLoop) {
		ctx.ui.notify(
			"No resumable Ralph loop state found in .ralph/loop.md",
			"error",
		);
		return;
	}

	const { state, task } = savedLoop;
	if (state.iteration <= 0 || state.max_iterations <= 0) {
		ctx.ui.notify("Ralph loop state is invalid and cannot be resumed", "error");
		return;
	}

	if (state.external_gate_entrypoint_digest) {
		const drift = validateExternalGateDigests(ctx.cwd, state);
		if (drift) {
			ctx.ui.notify(drift, "error");
			return;
		}
	}

	if (state.external_gate_cleanup_pending) {
		const failure = retryTerminalCleanup(ctx.cwd);
		ctx.ui.notify(
			failure ?? "Ralph external gate terminal cleanup recovered",
			failure ? "error" : "info",
		);
		if (failure) return;
	}

	const stopFailure = reconcileExternalStop(ctx.cwd);
	if (stopFailure) {
		ctx.ui.notify(stopFailure, "error");
		return;
	}
	resetExternalTerminalState(ctx.cwd);

	if (state.stop_reason === "complete" && !parsedArgs.force) {
		ctx.ui.notify(
			"Ralph loop already completed; use /ralph-resume --force or /ralph-restart",
			"info",
		);
		return;
	}

	if (state.iteration > state.max_iterations) {
		ctx.ui.notify(
			"Saved Ralph loop is already past max iterations and cannot be resumed",
			"error",
		);
		return;
	}

	const currentSessionId = ctx.sessionManager.getSessionId();
	const reuseCurrentSession =
		Boolean(state.session_id) && currentSessionId === state.session_id;
	ctx.ui.notify(formatResumeNotification(state, reuseCurrentSession), "info");

	if (reuseCurrentSession) {
		await resumeCurrentSession(pi, ctx);
		return;
	}

	await runLoop(pi, ctx, task, state.max_iterations, {
		startIteration: state.iteration,
		startedAt: state.started_at || new Date().toISOString(),
		initialErrorCount: state.error_count,
		bundleMode: state.bundle_mode,
		forceFreshSession: true,
		initialModelState: getSavedModelState(state),
		resumeState: state,
	});
}

async function handleRestartCommand(
	pi: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!ensureLoopNotRunning(ctx) || !reconcileTerminalBeforeNewToken(ctx)) return;

	const savedLoop = readSavedLoop(ctx.cwd);
	if (!savedLoop) {
		ctx.ui.notify(
			"No restartable Ralph loop state found in .ralph/loop.md",
			"error",
		);
		return;
	}

	const { state, task } = savedLoop;
	if (state.max_iterations <= 0) {
		ctx.ui.notify(
			"Ralph loop state is invalid and cannot be restarted",
			"error",
		);
		return;
	}

	ctx.ui.notify(
		`Restarting Ralph loop from iteration 1/${state.max_iterations} in a fresh session`,
		"info",
	);
	await runLoop(pi, ctx, task, state.max_iterations, {
		startIteration: 1,
		startedAt: new Date().toISOString(),
		initialErrorCount: 0,
		bundleMode: state.bundle_mode,
		forceFreshSession: true,
		initialModelState: getSavedModelState(state),
	});
}

function handleStopCommand(
	_pi: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!isLoopRunning(ctx.cwd)) {
		ctx.ui.notify("No Ralph loop is running", "info");
		return Promise.resolve();
	}

	updateState(ctx.cwd, { stop_requested: true });
	ctx.ui.notify("Ralph loop will stop after the current iteration", "info");
	return Promise.resolve();
}

function handleStatusCommand(
	_pi: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const savedLoop = readSavedLoop(ctx.cwd);
	if (!savedLoop?.state.running) {
		if (savedLoop?.state.stop_reason) {
			ctx.ui.notify(
				`Ralph loop (inactive): last run stopped at iteration ${savedLoop.state.iteration}/${savedLoop.state.max_iterations}, reason: ${savedLoop.state.stop_reason}`,
				"info",
			);
		} else {
			ctx.ui.notify("No active Ralph loop", "info");
		}
		return Promise.resolve();
	}

	ctx.ui.notify(formatStatusMessage(savedLoop.state), "info");
	return Promise.resolve();
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("ralph-loop", {
		description:
			'Start a Ralph loop — run a task iteratively in fresh sessions until <promise>COMPLETE</promise> or max iterations. Usage: /ralph-loop "task" [--max-iterations=N] [--dry-run]',
		getArgumentCompletions: getLoopArgumentCompletions,
		handler: handleLoopCommand.bind(null, pi),
	});

	pi.registerCommand("ralph-resume", {
		description:
			"Resume a saved Ralph loop from .ralph/loop.md. Completed loops require --force. From the session that owns the saved iteration, it resumes in place without re-sending the prompt (acting on an already-emitted promise or sending a control-tag nudge); from any other session, it restarts the saved iteration in a fresh session.",
		handler: handleResumeCommand.bind(null, pi),
	});

	pi.registerCommand("ralph-restart", {
		description:
			"Restart the saved Ralph loop from iteration 1 in a fresh session, reusing the prompt and max_iterations from .ralph/loop.md.",
		handler: handleRestartCommand.bind(null, pi),
	});

	pi.registerCommand("ralph-stop", {
		description:
			"Stop the currently running Ralph loop after the current iteration",
		handler: handleStopCommand.bind(null, pi),
	});

	pi.registerCommand("ralph-status", {
		description: "Show the current Ralph loop status",
		handler: handleStatusCommand.bind(null, pi),
	});
}
