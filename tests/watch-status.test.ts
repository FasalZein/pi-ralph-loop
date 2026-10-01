import assert from "node:assert/strict";
import test from "node:test";
import { execute } from "../src/watch/commands.ts";
import { Fixture, T, clock } from "./fixtures/loop-state.ts";

function bundle() {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }, { id: "C", passes: false }]);
	f.state(true, T("10:00"), "run-a", { owner_heartbeat_at: T("12:00") });
	f.journal([
		{ v: 1, k: "run", r: "L1", t: T("10:00"), m: "m", th: "off", mx: 9, tk: "b" },
		{ v: 1, k: "loop", r: "L1", t: T("10:00"), tok: "run-a", sa: T("10:00"), i: 1, ph: "initialized" },
	]);
	f.pass("A", T("10:30"));
	return f;
}

test("execute status shows scratch bundle progress, current item and hand-computed ETA; no driver is partial", async () => {
	const f = bundle();
	try {
		const outcome = await execute({ kind: "status", root: f.root }, { observation: clock() });
		assert.ok(outcome.ok && "status" in outcome);
		assert.equal(outcome.status.exitCode, 3);
		assert.match(outcome.status.text, /^items: 1\/3 passed$/m);
		assert.match(outcome.status.text, /^current item: B .*$/m);
		assert.match(outcome.status.text, /^health: RUNNING$/m);
		// One measured item took 30min. Two remain: 60min, n=1.
		assert.match(outcome.status.text, /^ETA: estimate 3600000 ms; n=1$/m);
		assert.match(outcome.status.text, /^activity: unavailable$/m);
		assert.match(outcome.status.text, /^coverage: partial$/m);
		assert.match(outcome.status.text, /^warning: activity /m);
	} finally { f.close(); }
});

import { createServer, type Socket } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMetadata } from "../src/watch/transport.ts";
import type { EventFrame } from "../src/watch/types.ts";
import { midRead } from "./fixtures/loop-state.ts";

const hello = (lastPiAt: string | null): Extract<EventFrame, { type: "hello" }> => ({
	v: 1, type: "hello", launchId: "L1", pid: process.pid, nextSeq: 1, lastPiAt,
	loop: { token: "run-a", startedAt: T("10:00"), iteration: 1 }, tools: [], state: "launched",
	totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0, dialogsCancelled: 0, refusals: 0 },
	counters: { dialogsCancelled: 0, refusals: 0, badRecords: 0, badFacts: 0, subscriberDrops: 0 },
});

async function socketServer(f: Fixture, send: (socket: Socket) => void) {
	const directory = mkdtempSync(join(tmpdir(), "rs-"));
	const path = join(directory, "events.sock");
	const sockets = new Set<Socket>();
	let disconnected!: () => void;
	const closed = new Promise<void>((resolve) => { disconnected = resolve; });
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => { sockets.delete(socket); disconnected(); });
		socket.resume();
		send(socket);
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
	writeMetadata(f.root, { v: 1, pid: process.pid, launchId: "L1", eventSocket: path, factSocket: join(directory, "facts.sock"), fifo: join(f.root, ".ralph/control.fifo"), startedAt: T("10:00") });
	return {
		closed,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

for (const [lastPiAt, stalled, health, age] of [
	[T("11:30"), true, "STALLED", 1800000],
	["2026-09-30T11:30:01.000Z", false, "RUNNING", 1799000],
	[T("12:00"), false, "RUNNING", 0],
] as const) test(`status connected hello: event age ${age} ms gives ${health}, complete evidence exits 0`, { timeout: 10_000 }, async () => {
	const f = bundle();
	const server = await socketServer(f, (socket) => socket.write(JSON.stringify(hello(lastPiAt)) + "\n"));
	try {
		const before = Object.fromEntries(readdirSync(join(f.root, ".ralph")).map((name) => [name, readFileSync(join(f.root, ".ralph", name), "utf8")]));
		const outcome = await execute({ kind: "status", root: f.root }, { observation: clock(), get host(): never { throw new Error("status must not use a host"); } });
		assert.ok(outcome.ok && "status" in outcome);
		assert.equal(outcome.status.exitCode, 0, outcome.status.text);
		assert.match(outcome.status.text, new RegExp(`^health: ${health}$`, "m"));
		assert.match(outcome.status.text, new RegExp(`^stalled: ${stalled}$`, "m"));
		assert.match(outcome.status.text, new RegExp(`^event age: ${age} ms$`, "m"));
		assert.match(outcome.status.text, /^coverage: complete$/m);
		assert.doesNotMatch(outcome.status.text, /^warning:/m);
		assert.deepEqual(Object.fromEntries(readdirSync(join(f.root, ".ralph")).map((name) => [name, readFileSync(join(f.root, ".ralph", name), "utf8")])), before);
		await server.closed;
	} finally { await server.close(); f.close(); }
});

for (const scenario of ["no timestamp", "wrong launch", "wrong token", "wrong start", "malformed", "no hello", "disconnect", "silent"] as const) test(`status ${scenario}: unavailable activity, exit 3, socket closed`, { timeout: 10_000 }, async () => {
	const f = bundle();
	const server = await socketServer(f, (socket) => {
		if (scenario === "silent") return;
		if (scenario === "disconnect") { socket.end(); return; }
		if (scenario === "malformed") { socket.write("bad frame\n"); return; }
		if (scenario === "no hello") { socket.write(JSON.stringify({ v: 1, type: "lifecycle", seq: 1, at: T("12:00"), state: "ready" }) + "\n"); return; }
		const frame = hello(scenario === "no timestamp" ? null : T("11:00"));
		socket.write(JSON.stringify({ ...frame, launchId: scenario === "wrong launch" ? "L2" : "L1", loop: { ...frame.loop, token: scenario === "wrong token" ? "other" : "run-a", startedAt: scenario === "wrong start" ? T("11:00") : T("10:00") } }) + "\n");
	});
	try {
		const started = Date.now();
		const outcome = await execute({ kind: "status", root: f.root }, { observation: clock() });
		assert.ok(outcome.ok && "status" in outcome);
		assert.equal(outcome.status.exitCode, 3);
		assert.match(outcome.status.text, /^activity: unavailable$/m);
		assert.match(outcome.status.text, /^stalled: unavailable$/m);
		assert.match(outcome.status.text, /^health: RUNNING$/m);
		assert.match(outcome.status.text, /^coverage: partial$/m);
		if (scenario === "silent") {
			assert.ok(Date.now() - started >= 2000);
			assert.match(outcome.status.text, /Driver hello unavailable after 2 s/);
		}
		await server.closed;
	} finally { await server.close(); f.close(); }
});

test("caller cancellation stops a silent status subscription and closes its socket", { timeout: 10_000 }, async () => {
	const f = bundle();
	const abort = new AbortController();
	const server = await socketServer(f, () => abort.abort(new Error("caller cancelled")));
	try {
		const outcome = await execute({ kind: "status", root: f.root }, { observation: clock(), signal: abort.signal });
		assert.deepEqual(outcome, { ok: false, error: "caller cancelled" });
		await server.closed;
	} finally { await server.close(); f.close(); }
});

for (const source of ["items", "state", "progress", "journal", "mission", "git", "concurrent"] as const) test(`status incomplete ${source} never looks clean even with a live driver`, async () => {
	const f = bundle();
	if (source === "items") writeFileSync(join(f.root, ".ralph/items.json"), '{"items":[');
	if (source === "state") writeFileSync(join(f.root, ".ralph/loop.md"), "---\nrunning: false\n");
	if (source === "progress") unlinkSync(join(f.root, ".ralph/progress.md"));
	if (source === "journal") f.appendJournalRaw("not-json\n");
	if (source === "mission") unlinkSync(join(f.root, ".ralph/mission.json"));
	if (source === "git") rmSync(join(f.root, ".git"), { recursive: true });
	const observation = source === "concurrent" ? midRead(() => f.commit("concurrent change", T("11:00"))) : clock();
	const server = await socketServer(f, (socket) => socket.write(JSON.stringify(hello(T("12:00"))) + "\n"));
	try {
		const outcome = await execute({ kind: "status", root: f.root }, { observation });
		assert.ok(outcome.ok && "status" in outcome);
		assert.equal(outcome.status.exitCode, 3, outcome.status.text);
		assert.match(outcome.status.text, /^coverage: partial$/m);
		assert.match(outcome.status.text, /^warning:/m);
		if (source === "items") { assert.match(outcome.status.text, /^items: unavailable$/m); assert.doesNotMatch(outcome.status.text, /0\/0 passed/); }
		if (source === "state") { assert.match(outcome.status.text, /^health: UNKNOWN$/m); assert.match(outcome.status.text, /^activity: unavailable$/m); }
		if (source === "journal") assert.match(outcome.status.text, /^ETA: n\/a; n=0$/m);
		await server.closed;
	} finally { await server.close(); f.close(); }
});

test("status before a pass shows ETA n/a with n=0, not a made-up estimate", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.state(true, T("10:00"), "run-a", { owner_heartbeat_at: T("12:00") });
		f.journal([{ v: 1, k: "loop", r: "L1", t: T("10:00"), tok: "run-a", sa: T("10:00"), i: 1, ph: "initialized" }]);
		const outcome = await execute({ kind: "status", root: f.root }, { observation: clock() });
		assert.ok(outcome.ok && "status" in outcome);
		assert.match(outcome.status.text, /^ETA: n\/a; n=0$/m);
	} finally { f.close(); }
});

test("stopped status has a separate stopped item and reason, never STALE", async () => {
	const f = bundle();
	try {
		f.state(false, T("10:00"), "run-a", { stop_reason: "manual_stop", completed_at: T("11:00"), owner_heartbeat_at: T("10:00") });
		const outcome = await execute({ kind: "status", root: f.root }, { observation: clock() });
		assert.ok(outcome.ok && "status" in outcome);
		assert.match(outcome.status.text, /^health: STOPPED$/m);
		assert.match(outcome.status.text, /^stale: false$/m);
		assert.match(outcome.status.text, /^current item: n\/a$/m);
		assert.match(outcome.status.text, /^stopped item: B .*$/m);
		assert.match(outcome.status.text, /^stop reason: manual_stop$/m);
	} finally { f.close(); }
});

test("plain task items are not-applicable; missing state is not-started", async () => {
	const f = new Fixture([], { plain: true });
	try {
		unlinkSync(join(f.root, ".ralph/items.json"));
		unlinkSync(join(f.root, ".ralph/progress.md"));
		const outcome = await execute({ kind: "status", root: f.root }, { observation: clock() });
		assert.ok(outcome.ok && "status" in outcome);
		assert.match(outcome.status.text, /^task: plain$/m);
		assert.match(outcome.status.text, /^items: not-applicable$/m);
		assert.match(outcome.status.text, /^health: NOT-STARTED$/m);
		assert.match(outcome.status.text, /^ETA: n\/a; n=0$/m);
		assert.doesNotMatch(outcome.status.text, /^warning: (items|attempts)/m);
	} finally { f.close(); }
});

test("status escapes terminal controls and multiline titles instead of forging fields", async () => {
	const f = bundle();
	try {
		f.items[1].title = "bad\x1b[31m\ncoverage: complete\r\u0085\u2028";
		f.writeBundle();
		const outcome = await execute({ kind: "status", root: f.root }, { observation: clock() });
		assert.ok(outcome.ok && "status" in outcome);
		assert.equal(outcome.status.text.split("\n").filter((line) => line.startsWith("coverage:")).length, 1);
		assert.match(outcome.status.text, /^coverage: partial$/m);
		assert.doesNotMatch(outcome.status.text, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/);
		assert.match(outcome.status.text, /bad\\u001b\[31m\\ncoverage: complete/);
	} finally { f.close(); }
});

test("STALE and STALLED remain independent status signals", async () => {
	const f = bundle();
	f.state(true, T("10:00"), "run-a", { owner_heartbeat_at: T("11:00") });
	const server = await socketServer(f, (socket) => socket.write(JSON.stringify(hello(T("12:00"))) + "\n"));
	try {
		const outcome = await execute({ kind: "status", root: f.root }, { observation: clock() });
		assert.ok(outcome.ok && "status" in outcome);
		assert.equal(outcome.status.exitCode, 0, outcome.status.text);
		assert.match(outcome.status.text, /^health: STALE$/m);
		assert.match(outcome.status.text, /^stale: true$/m);
		assert.match(outcome.status.text, /^stalled: false$/m);
		await server.closed;
	} finally { await server.close(); f.close(); }
});

test("all passed bundle has no current item and a zero remaining ETA", async () => {
	const f = bundle();
	try {
		f.pass("B", T("11:00"));
		f.pass("C", T("11:30"));
		const outcome = await execute({ kind: "status", root: f.root }, { observation: clock() });
		assert.ok(outcome.ok && "status" in outcome);
		assert.match(outcome.status.text, /^items: 3\/3 passed$/m);
		assert.match(outcome.status.text, /^current item: n\/a$/m);
		assert.match(outcome.status.text, /^ETA: estimate 0 ms; n=3$/m);
	} finally { f.close(); }
});
