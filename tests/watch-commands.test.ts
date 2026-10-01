import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execute, LAUNCH_READY_TIMEOUT_MS, STOP_ACK_TIMEOUT_MS } from "../src/watch/commands.ts";
import { connectEvents, immediateGate, runDriver } from "../src/watch/driver.ts";
import { loadMission } from "../src/watch/config.ts";
import { readHostRecord, writeHostRecord, type Host, type HostHandle } from "../src/watch/host.ts";
import { writeState } from "../src/state.ts";
import { tmuxHost } from "../src/watch/hosts/tmux.ts";
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
function recordingHost(dead: boolean | ((handle: HostHandle) => boolean) = false, openDelayMs = 0) {
	const calls: string[] = [];
	const closed: string[] = [];
	const host: Host = {
		async open(root, launchId, _role, signal) {
			calls.push("open");
			// Honors the startup signal like the tmux adapter, which then removes its session.
			if (openDelayMs) await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, openDelayMs); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
			return { v: 1, kind: "tmux", root, launchId, name: "n", socket: "/tmp/none", sessionId: "$9", windowId: "@9", paneId: "%9", createdAt: "x" } satisfies HostHandle;
		},
		async verify() { calls.push("verify"); return true; },
		async paneDead(handle) { return typeof dead === "function" ? dead(handle) : dead; },
		async close(handle) { calls.push("close"); closed.push(handle.launchId); },
	};
	return { host, calls, closed };
}
const handleFor = (root: string, launchId: string): HostHandle => ({ v: 1, kind: "tmux", root, launchId, name: "n", socket: "/tmp/none", sessionId: "$1", windowId: "@1", paneId: "%1", createdAt: "x" });
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

test("dead pane closes the unused session; a silent driver fails at the deadline and keeps its record", async (t) => {
	const root = scratch(t);
	const dead = recordingHost(true);
	let outcome = await execute({ kind: "launch", root, mode: "fresh" }, { host: dead.host, ...quiet });
	assert.ok(!outcome.ok && /exited before it was ready/.test(outcome.error));
	assert.deepEqual(dead.calls, ["open", "verify", "close"]);
	const silent = recordingHost(false);
	const started = Date.now();
	outcome = await execute({ kind: "launch", root, mode: "fresh" }, { host: silent.host, readyTimeoutMs: 300, ...quiet });
	assert.ok(!outcome.ok && /not ready within 0.3 s.*may remain: readiness deadline passed before cleanup/.test(outcome.error), JSON.stringify(outcome));
	assert.ok(Date.now() - started < 2000);
	// The deadline has passed: no cleanup window; the record lets the next launch recover the session.
	assert.deepEqual(silent.calls, ["open"]);
	assert.equal(readHostRecord(root)?.sessionId, "$9");
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

const piLog = (root: string) => join(root, "pi.log");
async function driver(t: test.TestContext, root: string, scenario: unknown, until: "launched" | "dispatched" | "ready" = "launched", gate = immediateGate) {
	const abort = new AbortController();
	const result = runDriver({ mission: await loadMission(root), launchId: "launch", gate, lifecycle: "managed" }, { piCommand: { file: process.execPath, args: ["--import", import.meta.resolve("tsx"), fakePi] }, env: { ...process.env, FAKE_PI_SCENARIO: JSON.stringify(scenario), FAKE_PI_STDIN_LOG: piLog(root) }, signal: abort.signal, tmpDir: root, shutdownGraceMs: 100, terminalPollMs: 50, log: () => {} });
	// Hooks run in order: the driver must exit before its root is removed. A managed
	// driver without terminal proof keeps pi; ending this test's own fake pi ends it.
	t.after(async () => {
		abort.abort();
		const pid = JSON.parse(readFileSync(piLog(root), "utf8").split("\n")[0]).pid;
		const timer = setTimeout(() => { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }, 500);
		await result; clearTimeout(timer); rmSync(root, { recursive: true, force: true });
	});
	for (const end = Date.now() + 5000; ;) {
		const prompted = existsSync(piLog(root)) && readFileSync(piLog(root), "utf8").includes('"type":"prompt"');
		if (until === "dispatched" && prompted) return { result };
		if (until === "ready" && existsSync(join(root, ".ralph/driver.json"))) return { result };
		try { for await (const frame of connectEvents({ root })) { if (until === "launched" && frame.type === "hello" && frame.state === "launched") return { result }; break; } } catch { /* not ready */ }
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
	await driver(t, root, { steps: [{ op: "state", running: true }, launchFact], stopSteps: [{ op: "state", running: true, stopRequested: true }, { op: "sleep", ms: 10000 }, { op: "exit", code: 0 }] });
	const { host, calls } = recordingHost();
	const lines: string[] = [];
	// The bound covers reads under suite load; pi stays running far longer, so the wait must time out.
	const outcome = await execute({ kind: "stop", root, timeoutMs: 1500 }, { host, pollMs: 50, err: (line) => lines.push(line) });
	assert.ok(!outcome.ok && /still stopping/.test(outcome.error), JSON.stringify(outcome));
	assert.ok(lines.some((line) => /stop accepted/.test(line)));
	assert.ok(lines.some((line) => /running=true, stop_requested=true/.test(line)));
	assert.deepEqual(calls, []);
	assert.ok(existsSync(join(root, ".ralph/driver.json")), "driver keeps running");
});

test("stop refuses closure when the run resumes during the cleanup wait (R2)", async (t) => {
	const root = scratch(t, true, false);
	await driver(t, root, { steps: [{ op: "state", running: true }, launchFact], stopSteps: [{ op: "state", running: false }] });
	writeHostRecord(handleFor(root, "launch"));
	let calls = 0;
	// The same run resumes after the command saw running=false, before the role exits.
	const { host, closed } = recordingHost(() => { if (++calls === 1) { state(root, { running: true }); return false; } return true; });
	const outcome = await execute({ kind: "stop", root, timeoutMs: null }, { host, pollMs: 50, ...quiet });
	assert.ok(!outcome.ok && /changed after stop/.test(outcome.error), JSON.stringify(outcome));
	assert.deepEqual(closed, []);
	assert.equal(readHostRecord(root)?.launchId, "launch");
});

test("stop without a launch fact never adopts a previous run's state (R3)", async (t) => {
	const root = scratch(t, true, false);
	state(root, { running: false, loop_token: "old-token", stop_reason: "manual_stop", owner_pid: null, owner_heartbeat_at: null });
	await driver(t, root, {}, "dispatched");
	writeHostRecord(handleFor(root, "launch"));
	const { host, closed } = recordingHost(false);
	const lines: string[] = [];
	const outcome = await execute({ kind: "stop", root, timeoutMs: 1500 }, { host, pollMs: 50, stopAckTimeoutMs: 200, err: (line) => lines.push(line) });
	assert.ok(!outcome.ok && /still stopping/.test(outcome.error), JSON.stringify(outcome));
	assert.ok(lines.some((line) => /first loop fact/.test(line)), lines.join("\n"));
	assert.deepEqual(closed, []);
});

test("stop before dispatch closes the unused session after the driver exits", async (t) => {
	const root = scratch(t, true, false);
	await driver(t, root, {}, "ready", () => new Promise<void>(() => {}));
	writeHostRecord(handleFor(root, "launch"));
	const { host, closed } = recordingHost(() => !existsSync(join(root, ".ralph/driver.json")));
	const outcome = await execute({ kind: "stop", root, timeoutMs: null }, { host, pollMs: 50, ...quiet });
	assert.ok(outcome.ok, JSON.stringify(outcome));
	assert.deepEqual(closed, ["launch"]);
	assert.equal(readHostRecord(root), null);
});

test("relaunch after natural completion recovers the inactive host record (R4)", async (t) => {
	const root = scratch(t);
	state(root, { running: false, stop_reason: "complete", owner_pid: null, owner_heartbeat_at: null });
	writeHostRecord(handleFor(root, "old-launch"));
	const { host, calls, closed } = recordingHost(true);
	const outcome = await execute({ kind: "launch", root, mode: "relaunch" }, { host, ...quiet });
	// No driver starts behind the recording host, so readiness fails after the recovery.
	assert.ok(!outcome.ok && /exited before it was ready/.test(outcome.error), JSON.stringify(outcome));
	assert.deepEqual(calls.slice(0, 3), ["verify", "close", "open"]);
	assert.equal(closed[0], "old-launch");
	assert.equal(readHostRecord(root), null);
});

test("launch refuses a previous session that still runs a process", async (t) => {
	const root = scratch(t);
	writeHostRecord(handleFor(root, "old-launch"));
	const { host, calls } = recordingHost(false);
	const outcome = await execute({ kind: "launch", root, mode: "fresh" }, { host, ...quiet });
	assert.ok(!outcome.ok && /still runs a process/.test(outcome.error), JSON.stringify(outcome));
	assert.deepEqual(calls, ["verify"]);
	assert.equal(readHostRecord(root)?.launchId, "old-launch");
});

test("launch readiness deadline bounds slow host startup (R6)", async (t) => {
	const root = scratch(t);
	const { host, calls } = recordingHost(false, 2000);
	const started = Date.now();
	const outcome = await execute({ kind: "launch", root, mode: "fresh" }, { host, readyTimeoutMs: 100, ...quiet });
	assert.ok(!outcome.ok && /not ready within 0.1 s/.test(outcome.error), JSON.stringify(outcome));
	assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
	assert.deepEqual(calls, ["open"]);
	assert.equal(readdirSync(join(root, ".ralph")).filter((name) => name.startsWith("launch-")).length, 0, "manifest removed");
});

test("concurrent launches open one host", async (t) => {
	const root = scratch(t);
	const { host, calls } = recordingHost(true, 100);
	const outcomes = await Promise.all([execute({ kind: "launch", root, mode: "fresh" }, { host, ...quiet }), execute({ kind: "launch", root, mode: "fresh" }, { host, ...quiet })]);
	assert.equal(calls.filter((call) => call === "open").length, 1);
	assert.ok(outcomes.some((outcome) => !outcome.ok && /Lock is active/.test(outcome.error)), JSON.stringify(outcomes));
});

test("resume refuses an exhausted budget", async (t) => {
	const root = scratch(t);
	state(root, { running: false, iteration: 4, max_iterations: 3, stop_reason: "max_iterations", owner_pid: null, owner_heartbeat_at: null });
	const { host, calls } = recordingHost();
	const outcome = await execute({ kind: "launch", root, mode: "resume" }, { host, ...quiet });
	assert.ok(!outcome.ok && /past its iteration budget/.test(outcome.error), JSON.stringify(outcome));
	assert.deepEqual(calls, []);
});

test("launch recovery refuses a previous session whose pane state cannot be read (G2)", async (t) => {
	const root = scratch(t);
	const socket = join(root, "fake-socket");
	writeFileSync(socket, "");
	const previous = { ...handleFor(root, "old-launch"), socket };
	writeHostRecord(previous);
	const calls: (readonly string[])[] = [];
	const identity = `$1\t@1\t%1\t${socket}\t${root}\told-launch\n`;
	const exec = async (args: readonly string[]) => {
		calls.push(args);
		const format = args.at(-1) ?? "";
		if (args.includes("display-message") && format.endsWith("#{pane_dead}")) return { code: 1, stdout: "", stderr: "injected query failure" };
		if (args.includes("display-message")) return { code: 0, stdout: identity, stderr: "" };
		if (args.includes("list-panes")) return { code: 0, stdout: "%1\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const outcome = await execute({ kind: "launch", root, mode: "fresh" }, { host: tmuxHost({ exec, env: {} }), ...quiet });
	assert.ok(!outcome.ok && /uncertain/.test(outcome.error), JSON.stringify(outcome));
	assert.equal(calls.some((args) => args.includes("kill-session")), false, "a live role is never closed on a failed query");
	assert.equal(readHostRecord(root)?.launchId, "old-launch");
});

test("launch fails at the readiness deadline even when host cleanup stalls (H1)", { timeout: 10_000 }, async (t) => {
	const root = scratch(t);
	const socket = join(root, "fake-socket");
	writeFileSync(socket, "");
	const calls: (readonly string[])[] = [];
	// Startup succeeds; afterwards the server stalls every client until its signal ends it.
	const exec = async (args: readonly string[], _env: NodeJS.ProcessEnv, signal?: AbortSignal) => {
		calls.push(args);
		if (args.includes("new-session")) return { code: 0, stdout: `$4\t@4\t%4\t${socket}\n`, stderr: "" };
		if (args.some((arg) => ["set-option", "show-environment", "respawn-pane"].includes(arg))) return { code: 0, stdout: "", stderr: "" };
		return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => signal?.addEventListener("abort", () => resolve({ code: 1, stdout: "", stderr: "killed" }), { once: true }));
	};
	const readyMs = 400;
	const started = Date.now();
	const outcome = await execute({ kind: "launch", root, mode: "fresh" }, { host: tmuxHost({ exec, env: {} }), readyTimeoutMs: readyMs, ...quiet });
	const elapsed = Date.now() - started;
	assert.ok(!outcome.ok && /not ready within 0.4 s.*\$4.*may remain/.test(outcome.error), JSON.stringify(outcome));
	// Failure arrives at the one readiness deadline, not deadline plus a cleanup window.
	assert.ok(elapsed < readyMs + 600, `${elapsed} ms`);
	assert.equal(calls.some((args) => args.includes("kill-session")), false);
	assert.equal(readHostRecord(root)?.sessionId, "$4", "record kept for the next launch's recovery");
});
