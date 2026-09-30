import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execute, LAUNCH_READY_TIMEOUT_MS, STOP_ACK_TIMEOUT_MS } from "../src/watch/commands.ts";
import { connectEvents, immediateGate, runDriver } from "../src/watch/driver.ts";
import { loadMission } from "../src/watch/config.ts";
import type { Host, HostHandle } from "../src/watch/host.ts";
import { writeState } from "../src/state.ts";
import type { RalphLoopState } from "../src/types.ts";

const fakePi = fileURLToPath(new URL("./fixtures/fake-pi-rpc.ts", import.meta.url));
function scratch(t: test.TestContext, mission = true, removeAfter = true): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "rw-t9-cmd-")));
	if (removeAfter) t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"], { cwd: root });
	mkdirSync(join(root, ".ralph"));
	const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	if (mission) writeFileSync(join(root, ".ralph/mission.json"), JSON.stringify({ version: 1, task: { kind: "plain", prompt: "Do the task." }, run: { model: "test-model", thinking: "high", maxIterations: 3, budgetAuthority: "Test" }, git: { baseCommit: sha }, rules: {}, host: { prefer: ["tmux"] } }));
	return root;
}
/** Recording host: no tmux; records calls and scripts pane liveness. */
function recordingHost(dead = false) {
	const calls: string[] = [];
	const host: Host = {
		async open(root, launchId) { calls.push("open"); return { v: 1, kind: "tmux", root, launchId, name: "n", socket: "/tmp/none", sessionId: "$9", windowId: "@9", paneId: "%9", createdAt: "x" } satisfies HostHandle; },
		async verify() { calls.push("verify"); return true; },
		async paneDead() { return dead; },
		async close() { calls.push("close"); },
	};
	return { host, calls };
}
function state(root: string, patch: Partial<RalphLoopState>): void {
	writeState(root, { running: true, iteration: 1, max_iterations: 3, started_at: "2026-09-30T00:00:00.000Z", completed_at: null, stop_reason: null, session_id: "s", last_session_file: null, owner_pid: process.pid, owner_heartbeat_at: new Date().toISOString(), error_count: 0, transitioning: false, cancel_requested: false, stop_requested: false, bundle_mode: false, loop_token: "token", model_provider: null, model_id: null, thinking_level: null, bundle_snapshot_hash: null, items_snapshot_hash: null, progress_size: null, progress_hash: null, progress_snapshot: null, source_doc_hashes: null, bundle_items_snapshot: null, git_head: null, bundle_rejection_count: 0, provider_recovery_fresh_fallback_used: false, limit_reminders: null, ...patch }, "Do the task.");
}
const quiet = { err: () => {} };

test("owner limits: launch readiness 30 s, fact 30 s, stop ack 15 s", () => {
	assert.equal(LAUNCH_READY_TIMEOUT_MS, 30_000);
	assert.equal(STOP_ACK_TIMEOUT_MS, 15_000);
});

test("launch rejects invalid mission before host open", async (t) => {
	const root = scratch(t, false);
	const { host, calls } = recordingHost();
	const outcome = await execute({ kind: "launch", root, mode: "fresh" }, { host, ...quiet });
	assert.equal(outcome.ok, false);
	assert.deepEqual(calls, []);
	assert.equal(existsSync(join(root, ".ralph/launch.lock")), false);
});

test("launch refuses live driver lock before ready metadata", async (t) => {
	const root = scratch(t);
	writeFileSync(join(root, ".ralph/driver.lock"), String(process.pid));
	const { host, calls } = recordingHost();
	const outcome = await execute({ kind: "launch", root, mode: "fresh" }, { host, ...quiet });
	assert.ok(!outcome.ok && /driver is active/.test(outcome.error));
	assert.deepEqual(calls, []);
});

test("launch refuses fresh owner; invalid state does not authorize takeover; resume refuses complete", async (t) => {
	const root = scratch(t);
	const { host, calls } = recordingHost();
	state(root, {});
	let outcome = await execute({ kind: "launch", root, mode: "relaunch" }, { host, ...quiet });
	assert.ok(!outcome.ok && /live owner/.test(outcome.error), JSON.stringify(outcome));
	writeFileSync(join(root, ".ralph/loop.md"), "---\nrunning: true\n");
	outcome = await execute({ kind: "launch", root, mode: "fresh" }, { host, ...quiet });
	assert.ok(!outcome.ok && /incomplete/.test(outcome.error), JSON.stringify(outcome));
	state(root, { running: false, stop_reason: "complete", owner_pid: null, owner_heartbeat_at: null });
	outcome = await execute({ kind: "launch", root, mode: "resume" }, { host, ...quiet });
	assert.ok(!outcome.ok && /completed/.test(outcome.error), JSON.stringify(outcome));
	assert.deepEqual(calls, []);
});

test("dead pane and silent driver fail readiness and close only the unused session", async (t) => {
	const root = scratch(t);
	const dead = recordingHost(true);
	let outcome = await execute({ kind: "launch", root, mode: "fresh" }, { host: dead.host, ...quiet });
	assert.ok(!outcome.ok && /exited before it was ready/.test(outcome.error));
	assert.deepEqual(dead.calls, ["open", "verify", "close"]);
	const silent = recordingHost(false);
	const started = Date.now();
	outcome = await execute({ kind: "launch", root, mode: "fresh" }, { host: silent.host, readyTimeoutMs: 300, ...quiet });
	assert.ok(!outcome.ok && /not ready/.test(outcome.error));
	assert.ok(Date.now() - started < 2000);
	assert.deepEqual(silent.calls, ["open", "verify", "close"]);
	assert.equal(existsSync(join(root, ".ralph/watch-host.json")), false);
	assert.equal(existsSync(join(root, ".ralph/launch.lock")), false);
});

test("dead driver stop never writes state", async (t) => {
	const root = scratch(t);
	state(root, { owner_pid: null, owner_heartbeat_at: null });
	const before = readFileSync(join(root, ".ralph/loop.md"));
	const { host, calls } = recordingHost();
	const outcome = await execute({ kind: "stop", root, timeoutMs: null }, { host, ...quiet });
	assert.ok(!outcome.ok && /No live driver/.test(outcome.error));
	assert.deepEqual(readFileSync(join(root, ".ralph/loop.md")), before);
	assert.deepEqual(calls, []);
});

async function driver(t: test.TestContext, root: string, scenario: unknown) {
	const abort = new AbortController();
	const result = runDriver({ mission: await loadMission(root), launchId: "launch", gate: immediateGate, lifecycle: "managed" }, { piCommand: { file: process.execPath, args: ["--import", import.meta.resolve("tsx"), fakePi] }, env: { ...process.env, FAKE_PI_SCENARIO: JSON.stringify(scenario) }, signal: abort.signal, tmpDir: root, shutdownGraceMs: 100, terminalPollMs: 50, log: () => {} });
	// Hooks run in order: the driver must exit before its root is removed.
	t.after(async () => { abort.abort(); await result; rmSync(root, { recursive: true, force: true }); });
	for (const end = Date.now() + 5000; ;) {
		try { for await (const frame of connectEvents({ root })) { if (frame.type === "hello" && frame.state === "launched") return { result }; break; } } catch { /* not ready */ }
		if (Date.now() > end) throw new Error("driver did not launch");
		await new Promise((r) => setTimeout(r, 20));
	}
}
const launchFact = { op: "fact", envelope: { version: 1, id: "1", sequence: 1, fact: { run: { launchId: "launch", loopToken: "token", startedAt: "2026-09-30T00:00:00.000Z" }, iteration: 1, at: "2026-09-30T00:00:00.000Z", kind: "iteration-start", phase: "initialized" } } };

test("stop ack times out and a sent receipt is failure", async (t) => {
	const root = scratch(t, true, false);
	// The launch answer and the stop answer are both late; the fact before the answer confirms launch.
	await driver(t, root, { preSteps: [{ op: "state", running: true }, launchFact], responseDelay: 1500, stopSteps: [{ op: "exit", code: 0 }] });
	const { host, calls } = recordingHost();
	const started = Date.now();
	const outcome = await execute({ kind: "stop", root, timeoutMs: null }, { host, stopAckTimeoutMs: 200, ...quiet });
	assert.ok(!outcome.ok && /No stop acknowledgement within 0.2 s; the stop may already have been sent/.test(outcome.error), JSON.stringify(outcome));
	assert.ok(Date.now() - started < 1200);
	assert.deepEqual(calls, []);
});

test("stop accepted is not terminal; timeout bounds only the terminal wait and leaves the host", async (t) => {
	const root = scratch(t, true, false);
	await driver(t, root, { steps: [{ op: "state", running: true }, launchFact], stopSteps: [{ op: "state", running: true, stopRequested: true }, { op: "sleep", ms: 2000 }, { op: "exit", code: 0 }] });
	const { host, calls } = recordingHost();
	const lines: string[] = [];
	const outcome = await execute({ kind: "stop", root, timeoutMs: 400 }, { host, pollMs: 50, err: (line) => lines.push(line) });
	assert.ok(!outcome.ok && /still stopping/.test(outcome.error), JSON.stringify(outcome));
	assert.ok(lines.some((line) => /stop accepted/.test(line)));
	assert.ok(lines.some((line) => /running=true, stop_requested=true/.test(line)));
	assert.deepEqual(calls, []);
	assert.ok(existsSync(join(root, ".ralph/driver.json")), "driver keeps running");
});
