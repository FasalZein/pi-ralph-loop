import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	createBundleSnapshot,
	loadRalphBundle,
} from "../src/bundle/index.ts";
import { registerEventHandlers } from "../src/events.ts";
import { readState, updateState, writeState } from "../src/state.ts";
import type { RalphLoopState } from "../src/types.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function makeEventsState(
	overrides: Partial<RalphLoopState> = {},
): RalphLoopState {
	const baseState: RalphLoopState = {
		running: true,
		iteration: 2,
		max_iterations: 5,
		started_at: "2026-04-08T00:00:00.000Z",
		completed_at: null,
		stop_reason: null,
		session_id: "session-1",
		last_session_file: "/sessions/session-1.jsonl",
		owner_pid: null,
		owner_heartbeat_at: null,
		error_count: 0,
		transitioning: false,
		cancel_requested: false,
		stop_requested: false,
		bundle_mode: false,
		loop_token: "token-1",
		model_provider: null,
		model_id: null,
		thinking_level: null,
		bundle_snapshot_hash: null,
		items_snapshot_hash: null,
		progress_size: null,
		progress_hash: null,
		progress_snapshot: null,
		source_doc_hashes: null,
		bundle_items_snapshot: null,
		git_head: null,
		bundle_rejection_count: 0,
		provider_recovery_fresh_fallback_used: false,
		limit_reminders: null,
	};
	return { ...baseState, ...overrides };
}

function createEventsHarness() {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-events-"));
	const handlers = new Map<string, EventHandler>();
	const notifications: Array<{ message: string; type: string }> = [];
	const sentMessages: string[] = [];
	const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
	const sessionNames: string[] = [];

	const pi = {
		on(name: string, handler: EventHandler) {
			handlers.set(name, handler);
		},
		sendUserMessage(message: string) {
			sentMessages.push(message);
		},
		setSessionName(name: string) {
			sessionNames.push(name);
		},
	} as unknown as ExtensionAPI;

	registerEventHandlers(pi);

	const ctx = {
		cwd,
		ui: {
			theme: { fg: (_token: string, text: string) => text },
			notify(message: string, type: string) {
				notifications.push({ message, type });
			},
			setStatus(key: string, value: string | undefined) {
				statusUpdates.push({ key, value });
			},
			setWorkingVisible(_visible: boolean) {},
		},
		sessionManager: {
			getSessionId: () => "session-2",
			getSessionFile: () => "/sessions/session-2.jsonl",
		},
	} as unknown as ExtensionContext;

	return {
		cwd,
		handlers,
		notifications,
		sentMessages,
		statusUpdates,
		sessionNames,
		ctx,
	};
}

function externalGateState(cwd: string, overrides: Partial<RalphLoopState> = {}): RalphLoopState {
	mkdirSync(join(cwd, ".ralph"), { recursive: true });
	writeFileSync(join(cwd, ".ralph", "plan.md"), "plan\n");
	writeFileSync(join(cwd, ".ralph", "prompt.md"), "prompt\n");
	writeFileSync(join(cwd, ".ralph", "progress.md"), "progress\n");
	writeFileSync(
		join(cwd, ".ralph", "items.json"),
		JSON.stringify({
			version: 1,
			runtime_contract: { external_gate: { entrypoint: "guard.mjs" } },
			items: [
				{
					category: "test",
					description: "lifecycle",
					steps: ["verify"],
					passes: false,
					regression_notes: "",
				},
			],
		}),
	);
	writeFileSync(
		join(cwd, "guard.mjs"),
		`let body = ""; for await (const chunk of process.stdin) body += chunk; const input = JSON.parse(body); const { appendFileSync, existsSync } = await import("node:fs"); appendFileSync("gate.log", JSON.stringify(input) + "\\n"); const reject = input.hook === "stop" && existsSync("reject-stop"); process.stdout.write(JSON.stringify({ version: 1, phase: input.hook, mode: "test", selected_issue: null, selected_title: null, start_head: input.heads.start, current_head: input.heads.current, accepted_head: input.heads.accepted, checks: [], journal_phase: null, linear_action: null, exit_code: reject ? 7 : 0, ok: !reject, ...(reject ? { message: "stop rejected" } : {}) }));`,
	);
	return {
		...makeEventsState(),
		...createBundleSnapshot(loadRalphBundle(cwd)),
		...overrides,
	};
}

function gateEvents(cwd: string): Array<Record<string, any>> {
	return readFileSync(join(cwd, "gate.log"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test("registers input handler for human recovery cancellation", () => {
	const h = createEventsHarness();

	assert.equal(typeof h.handlers.get("input"), "function");
});

test("session_before_switch blocks resume while loop is running", async () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState(), "task");

	const result = await h.handlers.get("session_before_switch")?.(
		{ reason: "resume" },
		h.ctx,
	);

	assert.deepEqual(result, { cancel: true });
	assert.deepEqual(h.notifications.at(-1), {
		message:
			"Ralph loop is running. /resume is blocked. Use another pi instance or /ralph-stop.",
		type: "warning",
	});
});

test("tool_call blocks configured tools while loop is running", async () => {
	const previous = process.env.RALPH_BLOCKED_TOOLS;
	process.env.RALPH_BLOCKED_TOOLS = "human_tool";
	try {
		const h = createEventsHarness();
		writeState(h.cwd, makeEventsState(), "task");

		const result = await h.handlers.get("tool_call")?.(
			{ toolName: "human_tool", toolCallId: "call-1", input: {} },
			h.ctx,
		);

		assert.deepEqual(result, {
			block: true,
			reason:
				'Tool "human_tool" is illegal to use during Ralph loops because it can block loop execution. The user is AFK during these loops; this is fully AI-driven development without human intervention.',
		});
		assert.deepEqual(h.notifications.at(-1), {
			message:
				'Tool "human_tool" is illegal to use during Ralph loops because it can block loop execution. The user is AFK during these loops; this is fully AI-driven development without human intervention.',
			type: "warning",
		});
	} finally {
		if (previous === undefined) {
			delete process.env.RALPH_BLOCKED_TOOLS;
		} else {
			process.env.RALPH_BLOCKED_TOOLS = previous;
		}
	}
});

test("tool_call ignores unconfigured tools while loop is running", async () => {
	const previous = process.env.RALPH_BLOCKED_TOOLS;
	process.env.RALPH_BLOCKED_TOOLS = "human_tool";
	try {
		const h = createEventsHarness();
		writeState(h.cwd, makeEventsState(), "task");

		const result = await h.handlers.get("tool_call")?.(
			{ toolName: "bash", toolCallId: "call-1", input: {} },
			h.ctx,
		);

		assert.equal(result, undefined);
		assert.deepEqual(h.notifications, []);
	} finally {
		if (previous === undefined) {
			delete process.env.RALPH_BLOCKED_TOOLS;
		} else {
			process.env.RALPH_BLOCKED_TOOLS = previous;
		}
	}
});

test("tool_call ignores configured tools outside a running loop", async () => {
	const previous = process.env.RALPH_BLOCKED_TOOLS;
	process.env.RALPH_BLOCKED_TOOLS = "human_tool";
	try {
		const h = createEventsHarness();

		const result = await h.handlers.get("tool_call")?.(
			{ toolName: "human_tool", toolCallId: "call-1", input: {} },
			h.ctx,
		);

		assert.equal(result, undefined);
		assert.deepEqual(h.notifications, []);
	} finally {
		if (previous === undefined) {
			delete process.env.RALPH_BLOCKED_TOOLS;
		} else {
			process.env.RALPH_BLOCKED_TOOLS = previous;
		}
	}
});

test("session_shutdown marks cancellation request", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState(), "task");

	h.handlers.get("session_shutdown")?.({}, h.ctx);

	assert.equal(readState(h.cwd)?.cancel_requested, true);
});

test("session_shutdown ignores a non-owner process quitting", () => {
	// Any other pi process in the same workspace (a one-shot `pi -p`, a helper
	// spawned by some extension, or just a second `pi` in the folder) loads the
	// extension and exits, firing session_shutdown reason "quit". Its pid differs
	// from the loop owner's pid, so it must NOT cancel the running loop.
	const h = createEventsHarness();
	writeState(
		h.cwd,
		makeEventsState({
			owner_pid: process.pid + 1,
			owner_heartbeat_at: new Date().toISOString(),
		}),
		"task",
	);

	h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.cancel_requested, false);
	assert.equal(state?.running, true);
});

test("session_shutdown still cancels when the owner process quits", () => {
	// Regression guard: a genuine cancel by the loop-owning process (its pid
	// matches owner_pid) must still mark the loop cancelled.
	const h = createEventsHarness();
	writeState(
		h.cwd,
		makeEventsState({
			owner_pid: process.pid,
			owner_heartbeat_at: new Date().toISOString(),
		}),
		"task",
	);

	h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

	assert.equal(readState(h.cwd)?.cancel_requested, true);
});

test("session_shutdown ignores a non-owner quit during a committed handoff", () => {
	// Another non-owner process quitting while the owner is mid-handoff must not
	// finalize the loop as interrupted; the owner's transition is untouched.
	const h = createEventsHarness();
	writeState(
		h.cwd,
		makeEventsState({
			transitioning: true,
			owner_pid: process.pid + 1,
			owner_heartbeat_at: new Date().toISOString(),
		}),
		"task",
	);

	h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, true);
	assert.equal(state?.transitioning, true);
	assert.equal(state?.stop_reason, null);
});

test("session_shutdown leaves a quit during a committed handoff resumable", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState({ transitioning: true }), "task");

	h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, false);
	// Resumable, not a fatal error: a valid NEXT already advanced the iteration.
	assert.equal(state?.stop_reason, "interrupted");
	assert.equal(state?.transitioning, false);
});

test("session_shutdown preserves Ralph-managed new-session transitions", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState({ transitioning: true }), "task");

	h.handlers.get("session_shutdown")?.({ reason: "new" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, true);
	assert.equal(state?.transitioning, true);
	assert.equal(state?.stop_reason, null);
});

test("model and thinking selection update the active owner loop state", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState({ session_id: "session-2" }), "task");

	h.handlers.get("model_select")?.(
		{ model: { provider: "anthropic", id: "claude-sonnet" } },
		h.ctx,
	);
	h.handlers.get("thinking_level_select")?.({ level: "high" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.model_provider, "anthropic");
	assert.equal(state?.model_id, "claude-sonnet");
	assert.equal(state?.thinking_level, "high");
});

test("model selection ignores foreign sessions and handoff transitions", () => {
	const h = createEventsHarness();
	writeState(
		h.cwd,
		makeEventsState({
			session_id: "session-1",
			model_provider: "openai",
			model_id: "gpt-5",
		}),
		"task",
	);

	h.handlers.get("model_select")?.(
		{ model: { provider: "anthropic", id: "claude-sonnet" } },
		h.ctx,
	);
	assert.equal(readState(h.cwd)?.model_provider, "openai");

	writeState(
		h.cwd,
		makeEventsState({ session_id: "session-2", transitioning: true }),
		"task",
	);
	h.handlers.get("model_select")?.(
		{ model: { provider: "anthropic", id: "claude-sonnet" } },
		h.ctx,
	);
	assert.equal(readState(h.cwd)?.model_provider, null);
});

test("session_start restores status for Ralph-created new sessions", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState({ transitioning: true }), "my task prompt");

	h.handlers.get("session_start")?.({ reason: "new" }, h.ctx);

	assert.deepEqual(h.sentMessages, []);
	assert.deepEqual(h.sessionNames, []);
	assert.ok(
		h.statusUpdates.some(
			(u) => u.key === "ralph-loop" && u.value !== undefined,
		),
	);
});

test("session_start does nothing for non-transitioning sessions", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState({ transitioning: false }), "task");

	h.handlers.get("session_start")?.({ reason: "new" }, h.ctx);

	// Should not send any messages.
	assert.deepEqual(h.sentMessages, []);
});

test("session_start on startup marks a crashed committed handoff resumable", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState({ transitioning: true }), "task");

	h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, false);
	// A NEXT already advanced the iteration before the crash; keep it resumable.
	assert.equal(state?.stop_reason, "interrupted");
});

test("session_start on startup preserves a live loop owned by another session", () => {
	const h = createEventsHarness();
	const ownerSessionFile = join(h.cwd, "owner-session.jsonl");
	writeFileSync(ownerSessionFile, "{}\n");
	writeState(
		h.cwd,
		makeEventsState({
			session_id: "owner-session",
			last_session_file: ownerSessionFile,
			transitioning: false,
		}),
		"task",
	);

	h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, true);
	assert.equal(state?.stop_reason, null);
	assert.equal(state?.transitioning, false);
	assert.ok(
		h.statusUpdates.some(
			(update) => update.key === "ralph-loop" && update.value === "Ralph 2/5",
		),
	);
});

test("session_start on startup errors a crashed mid-iteration loop", () => {
	const h = createEventsHarness();
	writeState(h.cwd, makeEventsState({ transitioning: false }), "task");

	h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, false);
	// No committed handoff: a mid-iteration crash is still a fatal error.
	assert.equal(state?.stop_reason, "error");
});

test("graceful process shutdown dispatches the external stop hook before cancellation", async () => {
	const h = createEventsHarness();
	writeState(h.cwd, externalGateState(h.cwd, { owner_pid: process.pid }), "task");

	await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, true);
	assert.equal(state?.cancel_requested, true);
	assert.equal(state?.external_gate_stop_dispatched, true);
	assert.deepEqual(gateEvents(h.cwd).map((event) => event.hook), ["stop"]);
});

test("startup recovers SIGKILL-style stale state through stop without cleanup", async () => {
	const h = createEventsHarness();
	writeState(
		h.cwd,
		externalGateState(h.cwd, {
			owner_pid: 123_456_789,
			owner_heartbeat_at: new Date(Date.now() - 61_000).toISOString(),
		}),
		"task",
	);

	await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, false);
	assert.equal(state?.stop_reason, "error");
	assert.equal(state?.external_gate_cleanup_pending, false);
	assert.deepEqual(gateEvents(h.cwd).map((event) => event.hook), ["stop"]);
});

test("crash recovery retries the first pending graceful stop reason", async () => {
	const h = createEventsHarness();
	writeState(h.cwd, externalGateState(h.cwd, { owner_pid: process.pid }), "task");
	writeFileSync(join(h.cwd, "reject-stop"), "reject\n");

	await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
	assert.equal(readState(h.cwd)?.external_gate_stop_pending, true);
	assert.equal(readState(h.cwd)?.external_gate_stop_reason, "user_cancelled");

	rmSync(join(h.cwd, "reject-stop"));
	updateState(h.cwd, {
		owner_pid: 123_456_789,
		owner_heartbeat_at: new Date(Date.now() - 61_000).toISOString(),
	});
	await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);

	const state = readState(h.cwd);
	assert.equal(state?.running, false);
	assert.equal(state?.external_gate_stop_pending, false);
	assert.equal(state?.external_gate_stop_dispatched, true);
	assert.equal(state?.external_gate_stop_reason, "user_cancelled");
	assert.deepEqual(
		gateEvents(h.cwd).map((event) => event.loop.stop_reason),
		["user_cancelled", "user_cancelled"],
	);
});
