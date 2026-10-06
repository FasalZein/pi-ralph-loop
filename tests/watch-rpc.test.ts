import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PiRpc, RpcMonitor } from "../src/watch/rpc.ts";
import type { DriverEvent } from "../src/watch/types.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi-rpc.ts", import.meta.url));
test("RPC: correlates responses, preserves LF framing and cancels dialogs", async () => {
	const events: DriverEvent[] = [];
	const monitor = new RpcMonitor((event) => events.push(event));
	const rpc = new PiRpc(process.execPath, ["--import", "tsx", fixture], { cwd: process.cwd(), env: { ...process.env, FAKE_PI_SCENARIO: JSON.stringify({ steps: [
		{ op: "raw", text: 'not-json\n' },
		{ op: "emit", record: { type: "extension_ui_request", id: "dialog", method: "input", title: "x\u2028y" } },
		{ op: "emit", record: { type: "extension_ui_request", id: "notify", method: "notify" } },
	] }) } }, monitor);
	try {
		assert.equal((await rpc.send({ type: "get_state" })).success, true);
		assert.equal((await rpc.send({ type: "prompt", message: "go" })).success, true);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(monitor.counters.badRecords, 1);
		assert.equal(monitor.counters.dialogsCancelled, 1);
		assert.ok(events.some((e) => e.kind === "dialog-cancelled" && e.title === "x\u2028y"));
	} finally { await rpc.close(100); }
});

test("RPC: final assistant usage counts once; capped assistant text is live only", () => {
	const events: DriverEvent[] = [];
	const monitor = new RpcMonitor((e) => events.push(e));
	const message = { role: "assistant", content: [{ type: "text", text: "SECRET" }], usage: { input: 12, output: 4, cacheRead: 7, cacheWrite: 3, cost: { total: 0.125 } } };
	for (const type of ["message_update", "message_end", "turn_end", "agent_end"]) monitor.record({ type, message, messages: [message] }, () => {});
	assert.deepEqual(monitor.totals, { input: 12, output: 4, cacheRead: 7, cacheWrite: 3, costUsd: 0.125, messages: 1, dialogsCancelled: 0, refusals: 0 });
	assert.deepEqual(events.filter((e) => e.kind === "message"), [{ kind: "message", text: "SECRET" }]);
	monitor.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "a".repeat(600) }, { type: "thinking", thinking: "private" }] } }, () => {});
	assert.equal(events.filter((e) => e.kind === "message").at(-1)?.text.length, 500);
	assert.equal(JSON.stringify(monitor.tools).includes("SECRET"), false);
});

test("RPC: tool buffer keeps 200 calls, pairs durations and retains unmatched ends", () => {
	let time = 0;
	const monitor = new RpcMonitor(() => {}, () => new Date(time));
	for (let i = 1; i <= 250; i++) monitor.record({ type: "tool_execution_start", toolCallId: String(i), toolName: "bash", args: {} }, () => {});
	assert.equal(monitor.tools.length, 200);
	assert.equal(monitor.tools[0].id, "51");
	time = 30;
	monitor.record({ type: "tool_execution_end", toolCallId: "250", isError: true }, () => {});
	assert.deepEqual(monitor.tools.at(-1), { id: "250", name: "bash", label: "{}", startedAt: new Date(0).toISOString(), endedAt: new Date(30).toISOString(), ms: 30, error: true });
	monitor.record({ type: "tool_execution_end", toolCallId: "unmatched", toolName: "read" }, () => {});
	assert.equal(monitor.tools.at(-1)?.startedAt, null);
	monitor.resetIteration();
	assert.deepEqual(monitor.tools, []);
});

test("RPC: cancels all dialogs, ignores notify, reports permission and ask_user refusals", () => {
	const replies: Record<string, unknown>[] = [];
	const events: DriverEvent[] = [];
	const monitor = new RpcMonitor((e) => events.push(e));
	for (const method of ["select", "confirm", "input", "editor", "notify", "setStatus"]) monitor.record({ type: "extension_ui_request", id: method, method }, (r) => replies.push(r));
	assert.equal(replies.length, 4);
	assert.ok(replies.every((r) => r.cancelled === true));
	for (const reason of ["Dangerous command requires confirmation", "Blocked by permission", "ask_user is illegal to use during Ralph loops"]) monitor.record({ type: "tool_execution_end", toolCallId: reason, isError: true, result: { content: [{ text: reason }] } }, () => {});
	assert.equal(monitor.counters.dialogsCancelled, 4);
	assert.equal(monitor.counters.refusals, 3);
	assert.equal(events.filter((e) => e.kind === "refusal").length, 3);
});

test("RPC: EOF rejects pending responses and shutdown terminates an EOF-resistant child", async () => {
	const monitor = new RpcMonitor(() => {});
	const rpc = new PiRpc(process.execPath, ["--import", "tsx", fixture], { env: { ...process.env, FAKE_PI_SCENARIO: '{"ready":"silent","ignoreEOF":true}' } }, monitor);
	const pending = assert.rejects(rpc.send({ type: "get_state" }), /pi-exited/);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(await rpc.close(50), null);
	await pending;
	assert.throws(() => process.kill(rpc.child.pid!, 0), { code: "ESRCH" });
});

test("RPC: a 50 MB single record is framed in linear time without blocking the event loop", async () => {
	const { monitorEventLoopDelay } = await import("node:perf_hooks");
	const monitor = new RpcMonitor(() => {});
	const rpc = new PiRpc(process.execPath, ["--import", "tsx", fixture], { env: { ...process.env, FAKE_PI_SCENARIO: JSON.stringify({ steps: [{ op: "big", bytes: 50_000_000 }, { op: "emit", record: { type: "agent_settled" } }] }) } }, monitor);
	const delay = monitorEventLoopDelay({ resolution: 10 });
	try {
		await rpc.send({ type: "get_state" });
		monitor.settled = false;
		delay.enable();
		const cpu = process.cpuUsage();
		await rpc.send({ type: "prompt", message: "go" });
		const end = Date.now() + 20_000;
		while (!monitor.settled && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
		delay.disable();
		const used = process.cpuUsage(cpu);
		const cpuMs = (used.user + used.system) / 1000;
		assert.equal(monitor.settled, true);
		assert.equal(monitor.counters.badRecords, 0);
		// Quadratic framing (re-concatenating and rescanning the whole buffer per 64 KB
		// chunk) spends about 2.5 s of CPU on this record; linear framing needs one
		// join, decode and JSON.parse, well under 1.2 s.
		assert.ok(cpuMs < 1200, `framing CPU ${Math.round(cpuMs)} ms`);
		assert.ok(delay.max / 1e6 < 1000, `max event-loop delay ${Math.round(delay.max / 1e6)} ms`);
	} finally { await rpc.close(100); }
});

test("RPC: an error notify is reported; info notify is not", () => {
	const errors: string[] = [];
	const monitor = new RpcMonitor(() => {});
	monitor.onErrorNotify = (message) => errors.push(message);
	monitor.record({ type: "extension_ui_request", id: "1", method: "notify", notifyType: "info", message: "fine" }, () => {});
	monitor.record({ type: "extension_ui_request", id: "2", method: "notify", notifyType: "error", message: "A Ralph loop is already running" }, () => {});
	assert.deepEqual(errors, ["A Ralph loop is already running"]);
});

test("RPC: assistant cap counts code points and keeps the emoji at character 500 intact", () => {
	const events: DriverEvent[] = [];
	const monitor = new RpcMonitor((e) => events.push(e));
	monitor.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `${"a".repeat(499)}😀extra` }] } }, () => {});
	assert.deepEqual(events.filter((e) => e.kind === "message"), [{ kind: "message", text: `${"a".repeat(499)}😀` }]);
});
