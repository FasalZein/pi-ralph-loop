import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { acquireLock, ensureFifo, readFifo, writeFifo, socketPaths, EventServer, LineServer, parseEnvelope, ControlError } from "../src/watch/transport.ts";

function root(t: test.TestContext): string {
	const dir = mkdtempSync("/tmp/rw-trans-");
	mkdirSync(join(dir, ".ralph"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
async function waitFor(check: () => boolean): Promise<void> {
	const end = Date.now() + 3000;
	while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 5)); }
}
test("FIFO: dead reader fails with no-reader and successive writers do not cause EOF", async (t) => {
	const dir = root(t);
	const fifo = ensureFifo(dir);
	assert.ok(lstatSync(fifo).isFIFO());
	assert.throws(() => writeFifo(fifo, "/ralph-stop"), (e: unknown) => e instanceof ControlError && e.code === "no-reader");
	const lines: string[] = [];
	const reader = readFifo(fifo, (line) => lines.push(line));
	t.after(() => reader.destroy());
	writeFifo(fifo, "/ralph-stop");
	await waitFor(() => lines.length === 1);
	writeFifo(fifo, '{"second":true}');
	await waitFor(() => lines.length === 2);
	assert.deepEqual(lines, ["/ralph-stop", '{"second":true}']);
});

test("FIFO: validates launch envelopes and enforces the atomic write limit", (t) => {
	const dir = root(t);
	const fifo = ensureFifo(dir);
	const base = { v: 1, id: "id", launch: "launch", token: null };
	assert.deepEqual(parseEnvelope(JSON.stringify({ ...base, op: "stop" })), { ...base, op: "stop" });
	assert.equal(parseEnvelope(JSON.stringify({ ...base, op: "steer", text: "injected" })), null);
	assert.equal(parseEnvelope(JSON.stringify({ ...base, v: 2, op: "stop" })), null);
	assert.equal(parseEnvelope(JSON.stringify({ ...base, op: "prompt" })), null);
	assert.equal(parseEnvelope("bad"), null);
	assert.throws(() => writeFifo(fifo, "a".repeat(512)), (e: unknown) => e instanceof ControlError && e.code === "too-large");
});

test("FIFO: rejects a regular file and does not pass an oversized partial line", async (t) => {
	const dir = root(t);
	const path = join(dir, ".ralph/rpc.in");
	writeFileSync(path, "bad");
	assert.throws(() => ensureFifo(dir), { code: "fifo-invalid" });
	rmSync(path);
	ensureFifo(dir);
	const lines: string[] = [];
	let bad = 0;
	const reader = readFifo(path, (line) => lines.push(line), () => bad++);
	t.after(() => reader.destroy());
	// Use the shell only in this test to bypass the safe writer's size guard.
	execFileSync("sh", ["-c", 'printf "%0600d\\n/ralph-stop\\n" 0 > "$1"', "test", path]);
	await waitFor(() => lines.length === 1);
	assert.deepEqual(lines, ["/ralph-stop"]);
	assert.equal(bad, 1);
});

test("transport: lock excludes second driver and recovers a dead lock", (t) => {
	const dir = root(t);
	const release = acquireLock(dir);
	assert.throws(() => acquireLock(dir), { code: "driver-active" });
	release();
	writeFileSync(join(dir, ".ralph/driver.lock"), "2147483647");
	acquireLock(dir)();
});

test("transport: socket paths hash canonical roots and fall back to /tmp", (t) => {
	const dir = root(t);
	const paths = socketPaths(dir, "/tmp/" + "long".repeat(40));
	assert.match(paths.eventSocket, /^\/tmp\/ralph-[a-f0-9]{16}-e.sock$/);
	assert.ok(Buffer.byteLength(paths.factSocket) <= 103);
});

const hello = (server: EventServer) => ({ v: 1 as const, type: "hello" as const, launchId: "launch", pid: process.pid, nextSeq: server.nextSeq, lastPiAt: null, loop: null, tools: [], totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0, dialogsCancelled: 0, refusals: 0 }, counters: { dialogsCancelled: 0, refusals: 0, badRecords: 0, badFacts: 0, subscriberDrops: 0 }, state: "ready" as const });

test("events: multiple subscribers receive hello then the same live sequence", async (t) => {
	const dir = root(t);
	const path = join(dir, "events.sock");
	const server: EventServer = new EventServer(path, () => hello(server), () => {});
	await server.listen();
	t.after(() => server.close());
	const streams: unknown[][] = [[], []];
	const clients = streams.map((frames) => {
		const client = connect(path);
		let buffer = "";
		client.setEncoding("utf8");
		client.on("data", (chunk: string) => {
			buffer += chunk; let end: number;
			while ((end = buffer.indexOf("\n")) >= 0) { frames.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
		});
		client.on("error", () => {});
		return client;
	});
	t.after(() => clients.forEach((c) => c.destroy()));
	await waitFor(() => streams.every((s) => s.length === 1));
	server.publish({ type: "event", event: { kind: "activity" } });
	await waitFor(() => streams.every((s) => s.length === 2));
	assert.deepEqual(streams[0], streams[1]);
	assert.equal((streams[0][0] as { nextSeq: number }).nextSeq, (streams[0][1] as { seq: number }).seq);
});

test("events: subscriber over 1 MB is dropped and reattaches with replay", async (t) => {
	const dir = root(t);
	let drops = 0;
	const path = join(dir, "events.sock");
	const server: EventServer = new EventServer(path, () => hello(server), () => drops++);
	await server.listen();
	t.after(() => server.close());
	const slow = connect(path);
	slow.on("error", () => {});
	t.after(() => slow.destroy());
	await new Promise<void>((resolve) => slow.once("connect", resolve));
	await new Promise((resolve) => setTimeout(resolve, 20));
	for (let i = 0; i < 10000; i++) server.publish({ type: "event", event: { kind: "refusal", tool: "bash", text: "x".repeat(200) } });
	await waitFor(() => drops === 1);
	const fresh = connect(path);
	t.after(() => fresh.destroy());
	const data = await new Promise<string>((resolve) => { fresh.setEncoding("utf8"); fresh.once("data", resolve); });
	assert.equal(JSON.parse(data.split("\n")[0]).nextSeq, 10001);
});

test("facts: receiver accepts reconnections and removes its socket", async (t) => {
	const dir = root(t);
	const path = join(dir, "fact.sock");
	const lines: string[] = [];
	const server = new LineServer(path, (line) => lines.push(line));
	await server.listen();
	for (const text of ["one", "two"]) await new Promise<void>((resolve) => {
		const client = connect(path); client.on("connect", () => client.end(`${text}\n`)); client.on("close", resolve);
	});
	assert.deepEqual(lines, ["one", "two"]);
	await server.close();
	assert.throws(() => lstatSync(path), { code: "ENOENT" });
});

test("transport: recovers stale socket but refuses a live socket", async (t) => {
	const dir = root(t);
	const path = join(dir, "stale.sock");
	// A crash leaves a socket inode. Simulate it with a short-lived child.
	execFileSync(process.execPath, ["--input-type=module", "-e", 'import {createServer} from "node:net"; createServer().listen(process.argv[1], () => process.exit(0));', path]);
	const server = new LineServer(path, () => {});
	await server.listen();
	try { await assert.rejects(new LineServer(path, () => {}).listen(), { code: "driver-active" }); }
	finally { await server.close(); }
});
