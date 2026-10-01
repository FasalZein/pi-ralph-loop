import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runDriver, fifoGate, releaseLaunch, controlLoop, connectEvents, immediateGate, type LaunchSpec } from "../src/watch/driver.ts";
import { loadMission } from "../src/watch/config.ts";
import type { EventFrame } from "../src/watch/types.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi-rpc.ts", import.meta.url));
function temp(t: test.TestContext): string {
	const root = mkdtempSync("/tmp/rw-driver-");
	mkdirSync(join(root, ".ralph"));
	return root;
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 5)); }
}
async function mission(root: string, prompt = "Do the task.") {
	const { execFileSync } = await import("node:child_process");
	const { writeFileSync } = await import("node:fs");
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"], { cwd: root });
	const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	writeFileSync(join(root, ".ralph/mission.json"), JSON.stringify({ version: 1, task: { kind: "plain", prompt }, run: { model: "test-model", thinking: "high", maxIterations: 3, budgetAuthority: "Test" }, git: { baseCommit: sha }, rules: {}, host: { prefer: ["tmux"] } }));
	return loadMission(root);
}
function log(root: string): Record<string, unknown>[] {
	const path = join(root, "pi.log");
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}
async function start(t: test.TestContext, scenario: unknown = {}, gate = immediateGate, extra: Record<string, number> = {}, specExtra: Pick<LaunchSpec, "mode" | "lifecycle"> = {}) {
	const root = temp(t);
	const m = await mission(root);
	const abort = new AbortController();
	const frames: EventFrame[] = [];
	const result = runDriver({ mission: m, launchId: "launch", gate, ...specExtra }, { piCommand: { file: process.execPath, args: ["--import", import.meta.resolve("tsx"), fixture] }, env: { ...process.env, FAKE_PI_SCENARIO: JSON.stringify(scenario), FAKE_PI_STDIN_LOG: join(root, "pi.log"), RALPH_BLOCKED_TOOLS: "other" }, signal: abort.signal, tmpDir: root, readyTimeoutMs: 300, shutdownGraceMs: 100, settleTimeoutMs: 100, log: () => {}, ...extra });
	t.after(async () => { abort.abort(); await result; rmSync(root, { recursive: true, force: true }); });
	await waitFor(() => existsSync(join(root, ".ralph/driver.json")));
	const consume = (async () => { for await (const frame of connectEvents({ root })) frames.push(frame); })();
	void consume.catch(() => {});
	t.after(async () => { await consume.catch(() => {}); });
	await waitFor(() => frames.length > 0);
	return { root, m, abort, frames, result, consume };
}

test("driver: spawns pi with policy, publishes ready and launches through RPC", async (t) => {
	const f = await start(t);
	await waitFor(() => log(f.root).some((r) => r.type === "prompt"));
	const records = log(f.root);
	assert.deepEqual(records[0].argv, ["--mode", "rpc", "--model", "test-model", "--thinking", "high"]);
	assert.deepEqual(records.find((r) => r.type === "prompt")?.message, "/ralph-loop Do the task. --max-iterations=3");
	const env = records[0].env as Record<string, unknown>;
	assert.equal(env.RALPH_WATCH_LAUNCH_ID, "launch");
	assert.equal(env.RALPH_BLOCKED_TOOLS, "other,ask_user");
	assert.ok(typeof env.RALPH_WATCH_FACT_SOCKET === "string");
	f.abort.abort();
	assert.equal((await f.result).reason, "aborted");
	await f.consume;
	assert.equal(f.frames.at(-1)?.type, "lifecycle");
	for (const path of ["driver.json", "driver.lock"]) assert.equal(existsSync(join(f.root, ".ralph", path)), false);
});

test("driver: launch prompt waits for the gate; stop before launch completes", async (t) => {
	let release!: () => void;
	const gate = () => new Promise<void>((resolve) => { release = resolve; });
	const f = await start(t, {}, gate);
	assert.equal(log(f.root).some((r) => r.type === "prompt"), false);
	const receipt = await controlLoop({ root: f.root, run: { launchId: "launch", loopToken: null, startedAt: null } }, { kind: "stop" });
	assert.equal(receipt.phase, "completed");
	assert.equal((await f.result).reason, "stopped-before-launch");
	assert.equal(log(f.root).some((r) => r.type === "prompt"), false);
	release();
});

test("driver: releaseLaunch over fifoGate launches and wrong launch is refused", async (t) => {
	const root = temp(t);
	const m = await mission(root);
	const abort = new AbortController();
	const result = runDriver({ mission: m, launchId: "launch", gate: fifoGate(root, "launch") }, { piCommand: { file: process.execPath, args: ["--import", import.meta.resolve("tsx"), fixture] }, env: { ...process.env, FAKE_PI_STDIN_LOG: join(root, "pi.log") }, signal: abort.signal, tmpDir: root, shutdownGraceMs: 100 });
	t.after(async () => { abort.abort(); await result; rmSync(root, { recursive: true, force: true }); });
	await waitFor(() => existsSync(join(root, ".ralph/driver.json")));
	assert.equal(log(root).some((r) => r.type === "prompt"), false);
	await assert.rejects(releaseLaunch({ root, launchId: "other" }), { code: "wrong-run" });
	assert.equal(log(root).some((r) => r.type === "prompt"), false);
	await releaseLaunch({ root, launchId: "launch" });
	await waitFor(() => log(root).some((r) => r.type === "prompt"));
});

function fact(sequence: number, detail: Record<string, unknown>, iteration = 1, launchId = "launch") {
	return { op: "fact", envelope: { version: 1, id: String(sequence), sequence, fact: { run: { launchId, loopToken: "token", startedAt: "2026-09-30T00:00:00.000Z" }, iteration, at: "2026-09-30T00:00:00.000Z", ...detail } } };
}
// The fact can precede the subscriber; hello then carries it as loop state.
const hasLoop = (frames: EventFrame[]) => frames.some((r) => (r.type === "hello" && r.loop !== null) || (r.type === "event" && r.event.kind === "fact"));
function currentHello(frames: EventFrame[]) { const hello = frames.find((f) => f.type === "hello"); assert.ok(hello?.type === "hello"); return hello; }
const run = { launchId: "launch", loopToken: "token", startedAt: "2026-09-30T00:00:00.000Z" };

test("driver: counts final usage once, records gate decisions and never persists raw pi output", async (t) => {
	const message = { role: "assistant", content: [{ text: "SECRET-ASSISTANT" }], usage: { input: 12, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.0123 } } };
	const f = await start(t, { steps: [
		{ op: "sleep", ms: 100 },
		fact(1, { kind: "iteration-start", phase: "initialized" }),
		{ op: "emit", record: { type: "message_update", message, delta: "SECRET-DELTA" } },
		{ op: "emit", record: { type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: { command: "echo hello" } } },
		{ op: "emit", record: { type: "tool_execution_end", toolCallId: "call", result: { content: [{ text: "SECRET-TOOL-OUTPUT" }] } } },
		{ op: "emit", record: { type: "message_end", message } },
		{ op: "emit", record: { type: "turn_end", message } },
		{ op: "emit", record: { type: "agent_end", messages: [message] } },
		fact(2, { kind: "promise-decision", promise: "NEXT", accepted: false, reason: "Missing commit" }),
		fact(4, { kind: "loop-ended", reason: "complete" }),
		{ op: "emit", record: { type: "agent_settled" } },
	] });
	assert.equal((await f.result).reason, "loop-finished");
	await f.consume;
	const { readJournal } = await import("../src/watch/journal.ts");
	const journal = readJournal(f.root);
	const usage = journal.records.filter((r) => r.k === "u");
	assert.equal(usage.length, 1);
	assert.deepEqual(usage[0], { v: 1, t: usage[0].t, r: "launch", k: "u", tok: "token", i: 1, in: 12, out: 5, cr: 3, cw: 2, c: 0.0123, n: 1, dc: 0, pr: 0 });
	assert.ok(journal.records.some((r) => r.k === "g" && r.ok === 0 && r.why === "Missing commit"));
	assert.ok(journal.records.some((r) => r.k === "d" && r.e === "gap" && r.why === "3-3"));
	assert.ok(f.frames.some((r) => r.type === "gap" && r.from === 3 && r.to === 3));
	for (const name of readdirSync(join(f.root, ".ralph"))) {
		if (name === "rpc.in") continue;
		assert.equal(readFileSync(join(f.root, ".ralph", name), "utf8").includes("SECRET-"), false);
	}
});

test("control: stop is idempotent even for concurrent requests and legacy stop", async (t) => {
	const f = await start(t, { responseDelay: 50, steps: [fact(1, { kind: "iteration-start", phase: "initialized" })] });
	await waitFor(() => hasLoop(f.frames));
	const [first, second] = await Promise.all([controlLoop({ root: f.root, run }, { kind: "stop" }), controlLoop({ root: f.root, run }, { kind: "stop" })]);
	assert.equal(first.phase, "accepted"); assert.equal(second.phase, "accepted");
	const { writeFifo } = await import("../src/watch/transport.ts");
	writeFifo(join(f.root, ".ralph/rpc.in"), "/ralph-stop");
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(log(f.root).filter((r) => r.message === "/ralph-stop").length, 1);
	assert.ok(f.frames.some((r) => r.type === "ack" && r.duplicate === true));
});

test("control: steer text travels through a file, is journaled in full and deleted after response", async (t) => {
	const f = await start(t, { steps: [{ op: "emit", record: { type: "agent_start" } }, fact(1, { kind: "iteration-start", phase: "initialized" })], responseDelay: 20 });
	await waitFor(() => hasLoop(f.frames));
	const text = "Operator note. ".repeat(1000);
	const receipt = await controlLoop({ root: f.root, run }, { kind: "steer", text });
	assert.equal(receipt.phase, "accepted");
	assert.equal(log(f.root).find((r) => r.type === "steer")?.message, text);
	await waitFor(() => readdirSync(join(f.root, ".ralph/steer")).length === 0);
	const { readJournal } = await import("../src/watch/journal.ts");
	assert.ok(readJournal(f.root).records.some((r) => r.k === "x" && r.op === "steer" && r.txt === text && r.ok === 1));
});

test("driver: pi-not-ready when pi exits before get_state answers", async (t) => {
	const root = temp(t);
	const m = await mission(root);
	const exit = await runDriver({ mission: m, launchId: "launch", gate: immediateGate }, { piCommand: { file: process.execPath, args: ["--import", import.meta.resolve("tsx"), fixture] }, env: { ...process.env, FAKE_PI_SCENARIO: '{"ready":"exit"}' }, tmpDir: root, shutdownGraceMs: 100, log: () => {} });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(exit.reason, "pi-not-ready");
	assert.deepEqual(readdirSync(join(root, ".ralph")).sort(), ["journal.jsonl", "mission.json", "rpc.in"]);
});

test("driver: pi EOF resolves pi-exited, ends subscribers and removes sockets and lock", async (t) => {
	const f = await start(t, { steps: [{ op: "sleep", ms: 100 }, { op: "exit", code: 3 }] });
	const hello = currentHello(f.frames);
	assert.ok(hello.state === "ready" || hello.state === "launched");
	const exit = await f.result;
	assert.equal(exit.reason, "pi-exited"); assert.equal(exit.code, 3);
	await f.consume;
	assert.ok(f.frames.some((r) => r.type === "lifecycle" && r.state === "pi-exited"));
	assert.equal(f.frames.at(-1)?.type === "lifecycle" && f.frames.at(-1)?.type, "lifecycle");
	assert.equal(readdirSync(f.root).some((n) => n.endsWith(".sock")), false);
	assert.equal(existsSync(join(f.root, ".ralph/driver.lock")), false);
});

test("driver: second driver on the same canonical root fails driver-active", async (t) => {
	const f = await start(t);
	const { symlinkSync } = await import("node:fs");
	const alias = `${f.root}-alias`;
	symlinkSync(f.root, alias);
	t.after(() => rmSync(alias, { force: true }));
	await assert.rejects(runDriver({ mission: { ...f.m, root: alias }, launchId: "other", gate: immediateGate }), { code: "driver-active" });
});

test("driver: tool buffer is current-iteration only and dialogs/refusals are reported", async (t) => {
	const steps: unknown[] = [{ op: "sleep", ms: 100 }, fact(1, { kind: "iteration-start", phase: "initialized" })];
	for (let i = 1; i <= 250; i++) steps.push({ op: "emit", record: { type: "tool_execution_start", toolCallId: `c${i}`, toolName: "bash", args: {} } });
	steps.push({ op: "emit", record: { type: "extension_ui_request", id: "d", method: "confirm", title: "Allow?" } });
	steps.push({ op: "emit", record: { type: "tool_execution_end", toolCallId: "c250", isError: true, result: { content: [{ text: "Blocked by permission" }] } } });
	const f = await start(t, { steps });
	await waitFor(() => log(f.root).some((r) => r.type === "extension_ui_response"));
	await waitFor(() => f.frames.some((r) => r.type === "event" && r.event.kind === "refusal"));
	const frames: EventFrame[] = [];
	for await (const frame of connectEvents({ root: f.root })) { frames.push(frame); break; }
	const hello = currentHello(frames);
	assert.equal(hello.tools.length, 200); assert.equal(hello.tools[0].id, "c51");
	assert.equal(hello.counters.dialogsCancelled, 1); assert.equal(hello.counters.refusals, 1);
	assert.equal(log(f.root).find((r) => r.type === "extension_ui_response")?.cancelled, true);
	// A new iteration resets the ring.
	const { connect } = await import("node:net");
	const metadata = JSON.parse(readFileSync(join(f.root, ".ralph/driver.json"), "utf8"));
	await new Promise<void>((resolve) => { const s = connect(metadata.factSocket); s.on("connect", () => s.end(`${JSON.stringify(fact(2, { kind: "iteration-start", phase: "entered" }, 2).envelope)}\n`)); s.on("close", () => resolve()); });
	await waitFor(() => f.frames.some((r) => r.type === "event" && r.event.kind === "fact" && r.event.fact.iteration === 2));
	const again: EventFrame[] = [];
	for await (const frame of connectEvents({ root: f.root })) { again.push(frame); break; }
	assert.deepEqual(currentHello(again).tools, []);
});

test("events: slow subscriber is dropped, pi output keeps flowing and reattach replays", async (t) => {
	const f = await start(t, { steps: [{ op: "sleep", ms: 200 }, ...Array.from({ length: 40 }, () => [{ op: "flood", n: 500 }, { op: "sleep", ms: 10 }]).flat(), fact(1, { kind: "iteration-start", phase: "initialized" })] });
	const { connect } = await import("node:net");
	const metadata = JSON.parse(readFileSync(join(f.root, ".ralph/driver.json"), "utf8"));
	const slow = connect(metadata.eventSocket);
	slow.on("error", () => {});
	let slowClosed = false;
	slow.on("close", () => { slowClosed = true; });
	slow.pause();
	t.after(() => slow.destroy());
	await waitFor(() => f.frames.some((r) => r.type === "event" && r.event.kind === "fact"), 15000);
	// A paused reader observes the driver-side close only once it reads again.
	slow.resume();
	await waitFor(() => slowClosed, 5000);
	const seqs = f.frames.flatMap((r) => r.type === "hello" ? [] : [r.seq]);
	assert.ok(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), "fast subscriber saw every sequence");
	const replay: EventFrame[] = [];
	for await (const frame of connectEvents({ root: f.root })) { replay.push(frame); break; }
	const hello = currentHello(replay);
	// The paced reader keeps up; only the paused reader is dropped.
	assert.equal(hello.counters.subscriberDrops, 1);
	assert.equal(hello.loop?.token, "token");
	assert.equal(hello.tools.length, 0);
});

test("control: wrong run, oversize, bad envelope and steer path escape are refused before pi", async (t) => {
	const f = await start(t, { steps: [fact(1, { kind: "iteration-start", phase: "initialized" })] });
	await waitFor(() => hasLoop(f.frames));
	await assert.rejects(controlLoop({ root: f.root, run: { ...run, loopToken: "other" } }, { kind: "stop" }), { code: "wrong-run" });
	const { writeFifo } = await import("../src/watch/transport.ts");
	const fifo = join(f.root, ".ralph/rpc.in");
	assert.throws(() => writeFifo(fifo, JSON.stringify({ v: 1, op: "stop", id: "x", launch: "launch", token: "t".repeat(600) })), { code: "too-large" });
	writeFifo(fifo, JSON.stringify({ v: 1, op: "steer", id: "bad", launch: "launch", token: null, text: "inject" }));
	writeFifo(fifo, "please do something else");
	writeFifo(fifo, JSON.stringify({ v: 1, op: "steer", id: "escape", launch: "launch", token: null, textPath: "../mission.json" }));
	writeFifo(fifo, JSON.stringify({ v: 1, op: "stop", id: "wrong", launch: "other", token: null }));
	await waitFor(() => ["bad", "escape", "wrong"].every((id) => f.frames.some((r) => r.type === "ack" && r.id === id && r.phase === "rejected")));
	const sent = log(f.root).filter((r) => r.type === "steer" || r.message === "/ralph-stop" || r.message === "please do something else");
	assert.deepEqual(sent, []);
	assert.equal(existsSync(join(f.root, ".ralph/mission.json")), true);
});

test("control: abort after send resolves sent", async (t) => {
	const f = await start(t, { responseDelay: 300, steps: [fact(1, { kind: "iteration-start", phase: "initialized" })] });
	await waitFor(() => hasLoop(f.frames));
	const abort = new AbortController();
	const pending = controlLoop({ root: f.root, run }, { kind: "stop" }, abort.signal);
	await waitFor(() => log(f.root).some((r) => r.message === "/ralph-stop"));
	abort.abort();
	assert.equal((await pending).phase, "sent");
});

test("control: dead driver gives no-driver/no-reader without hanging", async (t) => {
	const root = temp(t);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	await assert.rejects(controlLoop({ root, run }, { kind: "stop" }), { code: "no-driver" });
	const { ensureFifo, writeFifo } = await import("../src/watch/transport.ts");
	const started = Date.now();
	assert.throws(() => writeFifo(ensureFifo(root), "/ralph-stop"), { code: "no-reader" });
	assert.ok(Date.now() - started < 1000);
});

test("driver: refused /ralph-loop (handled plus error notify) ends launch-rejected and closes pi", async (t) => {
	// Ralph refuses before it answers the command (#10 follow-up 1).
	const f = await start(t, { preSteps: [{ op: "sleep", ms: 200 }, { op: "emit", record: { type: "extension_ui_request", id: "n", method: "notify", notifyType: "error", message: "A Ralph loop is already running" } }] });
	const exit = await f.result;
	assert.equal(exit.reason, "launch-rejected");
	assert.equal(exit.detail, "A Ralph loop is already running");
	assert.ok(log(f.root).some((r) => r.eof === true));
	assert.equal(f.frames.some((r) => r.type === "lifecycle" && r.state === "launched"), false);
});

test("driver: launch without a first iteration fact times out as launch-rejected", async (t) => {
	const f = await start(t, {}, immediateGate, { launchTimeoutMs: 300 });
	const exit = await f.result;
	assert.equal(exit.reason, "launch-rejected");
	assert.match(exit.detail ?? "", /iteration-start/);
	assert.ok(log(f.root).some((r) => r.eof === true));
});

test("driver: launched lifecycle follows the first iteration-start fact", async (t) => {
	const f = await start(t, { steps: [{ op: "sleep", ms: 100 }, fact(1, { kind: "iteration-start", phase: "initialized" })] });
	await waitFor(() => f.frames.some((r) => r.type === "lifecycle" && r.state === "launched"));
	const launchedAt = f.frames.findIndex((r) => r.type === "lifecycle" && r.state === "launched");
	const factAt = f.frames.findIndex((r) => r.type === "event" && r.event.kind === "fact");
	assert.ok(factAt >= 0 && factAt < launchedAt);
});

test("control: steer while no agent run is active is rejected not-streaming and journaled", async (t) => {
	const f = await start(t, { steps: [fact(1, { kind: "iteration-start", phase: "initialized" }), { op: "emit", record: { type: "agent_settled" } }] });
	await waitFor(() => hasLoop(f.frames) && log(f.root).length > 0);
	await new Promise((r) => setTimeout(r, 100));
	await assert.rejects(controlLoop({ root: f.root, run }, { kind: "steer", text: "too late" }), (e: { code?: string; message?: string }) => e.code === "rejected" && /not-streaming/.test(e.message ?? ""));
	assert.equal(log(f.root).some((r) => r.type === "steer"), false);
	const { readJournal } = await import("../src/watch/journal.ts");
	assert.ok(readJournal(f.root).records.some((r) => r.k === "x" && r.op === "steer" && r.ok === 0 && r.why === "not-streaming" && r.txt === "too late"));
	assert.deepEqual(readdirSync(join(f.root, ".ralph/steer")), []);
});

test("control: symlinked steer file or directory is rejected before pi", async (t) => {
	const f = await start(t, { steps: [{ op: "emit", record: { type: "agent_start" } }, fact(1, { kind: "iteration-start", phase: "initialized" })] });
	await waitFor(() => hasLoop(f.frames));
	const { mkdirSync: mkdir, writeFileSync, symlinkSync } = await import("node:fs");
	const { writeFifo } = await import("../src/watch/transport.ts");
	mkdir(join(f.root, ".ralph/steer"), { recursive: true });
	writeFileSync(join(f.root, "outside.txt"), "outside");
	symlinkSync(join(f.root, "outside.txt"), join(f.root, ".ralph/steer/link.txt"));
	writeFifo(join(f.root, ".ralph/rpc.in"), JSON.stringify({ v: 1, op: "steer", id: "file-link", launch: "launch", token: null, textPath: ".ralph/steer/link.txt" }));
	await waitFor(() => f.frames.some((r) => r.type === "ack" && r.id === "file-link" && r.phase === "rejected"));
	rmSync(join(f.root, ".ralph/steer"), { recursive: true });
	mkdir(join(f.root, "elsewhere"));
	writeFileSync(join(f.root, "elsewhere/x.txt"), "outside");
	symlinkSync(join(f.root, "elsewhere"), join(f.root, ".ralph/steer"));
	writeFifo(join(f.root, ".ralph/rpc.in"), JSON.stringify({ v: 1, op: "steer", id: "dir-link", launch: "launch", token: null, textPath: ".ralph/steer/x.txt" }));
	await waitFor(() => f.frames.some((r) => r.type === "ack" && r.id === "dir-link" && r.phase === "rejected"));
	assert.equal(log(f.root).some((r) => r.type === "steer"), false);
	assert.equal(readFileSync(join(f.root, "outside.txt"), "utf8"), "outside");
});

test("driver: loop-ended without agent_settled finishes after the settle timeout", async (t) => {
	const f = await start(t, { steps: [{ op: "emit", record: { type: "agent_start" } }, fact(1, { kind: "iteration-start", phase: "initialized" }), fact(2, { kind: "loop-ended", reason: "complete" })] }, immediateGate, { settleTimeoutMs: 300 });
	assert.equal((await f.result).reason, "loop-finished");
	// The fact can precede the test subscriber, so time it from the journal:
	// launch confirmation (first fact) to exit spans the settle timeout.
	const { readJournal } = await import("../src/watch/journal.ts");
	const records = readJournal(f.root).records;
	const at = (e: string) => Date.parse(records.find((r) => r.k === "d" && r.e === e)!.t);
	assert.ok(at("exit") - at("launched") >= 250, `${at("exit") - at("launched")} ms`);
});

test("control: stop after the launch prompt but before the first fact ends the launch", async (t) => {
	const f = await start(t);
	await waitFor(() => log(f.root).some((r) => r.type === "prompt"));
	const receipt = await controlLoop({ root: f.root, run: { launchId: "launch", loopToken: null, startedAt: null } }, { kind: "stop" });
	assert.equal(receipt.phase, "completed");
	assert.equal((await f.result).reason, "stopped-before-launch");
	assert.equal(log(f.root).some((r) => r.message === "/ralph-stop"), false);
});

test("driver: plain prompt with reserved --max-iterations is refused before pi gets it", async (t) => {
	const root = temp(t);
	const m = await mission(root, "Do it --max-iterations=99");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const exit = await runDriver({ mission: m, launchId: "launch", gate: immediateGate }, { piCommand: { file: process.execPath, args: ["--import", import.meta.resolve("tsx"), fixture] }, env: { ...process.env, FAKE_PI_STDIN_LOG: join(root, "pi.log") }, tmpDir: root, shutdownGraceMs: 100, log: () => {} });
	assert.equal(exit.reason, "launch-rejected");
	assert.match(exit.detail ?? "", /--max-iterations/);
	assert.equal(log(root).some((r) => r.type === "prompt"), false);
});

const notify = (message: string) => ({ type: "extension_ui_request", id: "n", method: "notify", notifyType: "error", message });
const managed = { lifecycle: "managed" } as const;
const noEof = (root: string) => !log(root).some((r) => r.eof === true);

test("driver: error notify after correlated response does not reject even in same chunk", async (t) => {
	// get_state is d-1, the launch prompt d-2: answer and unrelated error arrive in one write.
	const f = await start(t, { silentPrompt: true, steps: [
		{ op: "raw", text: `${JSON.stringify({ type: "response", id: "d-2", command: "prompt", success: true })}\n${JSON.stringify(notify("other extension failed"))}\n` },
		{ op: "sleep", ms: 50 }, fact(1, { kind: "iteration-start", phase: "initialized" }),
	] });
	await waitFor(() => f.frames.some((r) => r.type === "lifecycle" && r.state === "launched"));
	assert.equal(f.frames.some((r) => r.type === "lifecycle" && r.state === "closed"), false);
});

test("driver: silent launch response cannot bypass fact deadline", async (t) => {
	const f = await start(t, { silentPrompt: true }, immediateGate, { launchTimeoutMs: 300 });
	const exit = await f.result;
	assert.equal(exit.reason, "launch-rejected");
	assert.match(exit.detail ?? "", /iteration-start/);
});

test("driver: resume sends ralph-resume and accepts resumed as confirmation", async (t) => {
	const f = await start(t, { steps: [{ op: "sleep", ms: 50 }, fact(1, { kind: "iteration-start", phase: "resumed" }, 2)] }, immediateGate, {}, { mode: "resume" });
	await waitFor(() => f.frames.some((r) => r.type === "lifecycle" && r.state === "launched"));
	assert.equal(log(f.root).find((r) => r.type === "prompt")?.message, "/ralph-resume");
});

test("driver: managed stop before dispatch closes idle pi", async (t) => {
	let release!: () => void;
	const f = await start(t, {}, () => new Promise<void>((resolve) => { release = resolve; }), {}, managed);
	const receipt = await controlLoop({ root: f.root, run: { launchId: "launch", loopToken: null, startedAt: null } }, { kind: "stop" });
	assert.equal(receipt.phase, "completed");
	assert.equal((await f.result).reason, "stopped-before-launch");
	assert.ok(log(f.root).some((r) => r.eof === true));
	release();
});

test("driver: managed stop after dispatch before fact sends graceful stop", async (t) => {
	const f = await start(t, { stopSteps: [{ op: "sleep", ms: 300 }, { op: "exit", code: 0 }] }, immediateGate, {}, managed);
	await waitFor(() => log(f.root).some((r) => r.type === "prompt"));
	const receipt = await controlLoop({ root: f.root, run: { launchId: "launch", loopToken: null, startedAt: null } }, { kind: "stop" });
	assert.equal(receipt.phase, "accepted");
	assert.ok(log(f.root).some((r) => r.message === "/ralph-stop"));
	assert.ok(noEof(f.root), "pi stdin must stay open after dispatch");
	assert.equal((await f.result).reason, "pi-exited");
});

test("driver: managed launch timeout retains running pi and control", async (t) => {
	const f = await start(t, { stopSteps: [{ op: "sleep", ms: 600 }, { op: "exit", code: 0 }] }, immediateGate, { launchTimeoutMs: 200 }, managed);
	await waitFor(() => f.frames.some((r) => r.type === "lifecycle" && r.state === "launch-failed"));
	await waitFor(() => log(f.root).some((r) => r.message === "/ralph-stop"));
	assert.ok(noEof(f.root));
	assert.ok(existsSync(join(f.root, ".ralph/driver.json")));
	assert.equal((await f.result).reason, "pi-exited");
});

test("driver: managed launch abort after first fact requests stop without kill", async (t) => {
	const f = await start(t, { steps: [fact(1, { kind: "iteration-start", phase: "initialized" }), { op: "state", running: true }], stopSteps: [{ op: "sleep", ms: 300 }, { op: "state", running: false }] }, immediateGate, { terminalPollMs: 50 }, managed);
	await waitFor(() => f.frames.some((r) => r.type === "lifecycle" && r.state === "launched") || f.frames.some((r) => r.type === "hello" && r.state === "launched"));
	f.abort.abort();
	await waitFor(() => log(f.root).some((r) => r.message === "/ralph-stop"));
	await new Promise((r) => setTimeout(r, 150));
	assert.ok(noEof(f.root), "running loop must not be closed");
	const exit = await f.result;
	assert.equal(exit.reason, "aborted");
	assert.ok(log(f.root).some((r) => r.eof === true));
});

test("driver: managed partial terminal sample never closes pi", async (t) => {
	const f = await start(t, { steps: [
		fact(1, { kind: "iteration-start", phase: "initialized" }), { op: "state", running: true },
		fact(2, { kind: "loop-ended", reason: "complete" }), { op: "emit", record: { type: "agent_settled" } },
		{ op: "state", running: true, partial: true }, { op: "sleep", ms: 500 }, { op: "state", running: false },
	] }, immediateGate, { terminalPollMs: 50 }, managed);
	await waitFor(() => f.frames.some((r) => r.type === "event" && r.event.kind === "fact" && r.event.fact.kind === "loop-ended") || f.frames.some((r) => r.type === "hello" && r.loop !== null));
	await new Promise((r) => setTimeout(r, 250));
	assert.ok(noEof(f.root), "partial state is not terminal proof");
	assert.equal((await f.result).reason, "loop-finished");
});

test("driver: managed rejection while running requests graceful stop and keeps pi (R1)", async (t) => {
	// Refusal notify before the answer, valid running state, no fact: the old route closed stdin without /ralph-stop.
	const f = await start(t, { preSteps: [{ op: "state", running: true }, { op: "sleep", ms: 200 }, { op: "emit", record: notify("refused") }], responseDelay: 100, stopSteps: [{ op: "sleep", ms: 400 }, { op: "exit", code: 0 }] }, immediateGate, {}, managed);
	await waitFor(() => log(f.root).some((r) => r.message === "/ralph-stop"));
	assert.ok(noEof(f.root), "pi stdin must stay open while the loop may run");
	// The subscriber attaches at ready; the 200 ms pre-answer pause keeps the frame after it.
	await waitFor(() => f.frames.some((r) => r.type === "lifecycle" && r.state === "launch-failed" && r.detail === "refused"));
	assert.equal((await f.result).reason, "pi-exited");
	assert.ok(noEof(f.root));
});

test("driver: managed launch refuses an owner that appears at the gate without launch or stop (R5)", async (t) => {
	let root = "";
	const gate = async () => {
		// A foreign loop with a live owner starts while the driver waits at its gate.
		const { writeState } = await import("../src/state.ts");
		writeState(root, { running: true, iteration: 1, max_iterations: 3, started_at: "2026-09-30T00:00:00.000Z", completed_at: null, stop_reason: null, session_id: "foreign", last_session_file: null, owner_pid: process.pid, owner_heartbeat_at: new Date().toISOString(), error_count: 0, transitioning: false, cancel_requested: false, stop_requested: false, bundle_mode: false, loop_token: "foreign-token", model_provider: null, model_id: null, thinking_level: null, bundle_snapshot_hash: null, items_snapshot_hash: null, progress_size: null, progress_hash: null, progress_snapshot: null, source_doc_hashes: null, bundle_items_snapshot: null, git_head: null, bundle_rejection_count: 0, provider_recovery_fresh_fallback_used: false, limit_reminders: null }, "Foreign.");
	};
	const rootDir = temp(t);
	root = rootDir;
	const m = await mission(rootDir);
	t.after(() => rmSync(rootDir, { recursive: true, force: true }));
	const exit = await runDriver({ mission: m, launchId: "launch", gate, lifecycle: "managed" }, { piCommand: { file: process.execPath, args: ["--import", import.meta.resolve("tsx"), fixture] }, env: { ...process.env, FAKE_PI_STDIN_LOG: join(rootDir, "pi.log") }, tmpDir: rootDir, shutdownGraceMs: 100, log: () => {} });
	assert.equal(exit.reason, "launch-rejected");
	assert.match(exit.detail ?? "", /live owner/);
	assert.equal(log(rootDir).some((r) => r.type === "prompt"), false, "neither /ralph-loop nor /ralph-stop reaches pi");
});
