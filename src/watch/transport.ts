import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { connect, createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { includes, object } from "./journal.js";
import { CONTROL_PROMISES } from "../loop/control-promise.js";
import { ITERATION_START_PHASES } from "../loop/watch-events.js";
import { STOP_REASONS } from "../types.js";
import type { ControlOp, DriverEvent, EventFrame, IterationTotals, ToolEntry } from "./types.js";
import type { LoopFact, LoopFactEnvelope } from "../loop/watch-events.js";

export const FIFO_ENVELOPE_MAX_BYTES = 512;
export const SUBSCRIBER_QUEUE_LIMIT_BYTES = 1_048_576;
export class DriverError extends Error {
	readonly code: "driver-active" | "fifo-invalid" | "socket-path-too-long" | "bind-failed" | "not-a-ralph-root";
	constructor(code: "driver-active" | "fifo-invalid" | "socket-path-too-long" | "bind-failed" | "not-a-ralph-root", detail: string) { super(detail); this.code = code; this.name = "DriverError"; }
}
export class ControlError extends Error {
	readonly code: "no-driver" | "no-reader" | "wrong-run" | "rejected" | "too-large" | "busy" | "disconnected";
	constructor(code: "no-driver" | "no-reader" | "wrong-run" | "rejected" | "too-large" | "busy" | "disconnected", detail: string) { super(detail); this.code = code; this.name = "ControlError"; }
}
const code = (error: unknown): string | undefined => object(error) && typeof error.code === "string" ? error.code : undefined;
export function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return code(error) !== "ESRCH"; }
}
/** Exclusive per-root PID lock; a lock whose PID is dead is recovered. */
export function acquireLock(root: string, name = "driver.lock"): () => void {
	const path = join(root, ".ralph", name);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx", 0o600);
			try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
			return () => { unlinkSync(path); };
		} catch (error) {
			if (code(error) !== "EEXIST") throw error;
			const pid = Number(readFileSync(path, "utf8"));
			if (!Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid)) throw new DriverError("driver-active", `Lock is active: ${path}`);
			unlinkSync(path);
		}
	}
	throw new DriverError("driver-active", `Could not acquire ${path}`);
}
export function ensureFifo(root: string): string {
	const path = join(root, ".ralph/rpc.in");
	if (!existsSync(path)) execFileSync("mkfifo", ["-m", "600", path]);
	if (!lstatSync(path).isFIFO()) throw new DriverError("fifo-invalid", `Not a FIFO: ${path}`);
	return path;
}
/** LF only; setEncoding preserves UTF-8 across chunk boundaries. */
export function readLines(socket: NodeJS.ReadableStream, onLine: (line: string) => void, maxBytes = Infinity, onOversize: () => void = () => {}): void {
	let buffer = "";
	let discarding = false;
	if ("setEncoding" in socket && typeof socket.setEncoding === "function") socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!discarding) {
				if (Buffer.byteLength(line) + 1 <= maxBytes) onLine(line.replace(/\r$/, ""));
				else onOversize();
			}
			discarding = false;
		}
		if (Buffer.byteLength(buffer) > maxBytes) {
			if (!discarding) onOversize();
			discarding = true; buffer = "";
		}
	});
}
export function readFifo(path: string, onLine: (line: string) => void, onOversize?: () => void): Socket {
	const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
	const reader = new Socket({ fd, readable: true, writable: false });
	readLines(reader, onLine, FIFO_ENVELOPE_MAX_BYTES, onOversize);
	return reader;
}
export function writeFifo(path: string, line: string): void {
	if (line.includes("\n")) throw new ControlError("rejected", "FIFO command must be one line");
	const bytes = Buffer.from(`${line}\n`);
	if (bytes.length > FIFO_ENVELOPE_MAX_BYTES) throw new ControlError("too-large", "FIFO envelope exceeds 512 bytes");
	let fd: number;
	try { fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK); }
	catch (error) {
		if (code(error) === "ENXIO") throw new ControlError("no-reader", "FIFO has no driver reader");
		if (code(error) === "ENOENT") throw new ControlError("no-driver", "FIFO is missing");
		throw error;
	}
	try {
		if (writeSync(fd, bytes) !== bytes.length) throw new ControlError("busy", "FIFO write was incomplete");
	} catch (error) {
		if (code(error) === "EAGAIN") throw new ControlError("busy", "FIFO is full");
		throw error;
	} finally { closeSync(fd); }
}
export type Envelope = { readonly v: 1; readonly id: string; readonly launch: string; readonly token: string | null } & (
	| { readonly op: "stop" | "go" }
	| { readonly op: "steer"; readonly textPath: string }
);
export function parseEnvelope(line: string): Envelope | null {
	if (Buffer.byteLength(line) + 1 > FIFO_ENVELOPE_MAX_BYTES) return null;
	let value: unknown;
	try { value = JSON.parse(line); } catch { return null; }
	if (!object(value) || value.v !== 1 || typeof value.id !== "string" || value.id.length === 0 || value.id.length > 64 || typeof value.launch !== "string" || value.launch.length === 0) return null;
	const token = value.token === undefined && value.op === "go" ? null : value.token;
	if (token !== null && typeof token !== "string") return null;
	const common = { v: 1 as const, id: value.id, launch: value.launch, token };
	if (value.op === "stop" || value.op === "go") return { ...common, op: value.op };
	if (value.op === "steer" && typeof value.textPath === "string" && value.textPath.length > 0) return { ...common, op: "steer", textPath: value.textPath };
	return null;
}
export function socketPaths(root: string, temp = tmpdir()): { eventSocket: string; factSocket: string } {
	const hash = createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16);
	const path = (suffix: string) => {
		let result = join(temp, `ralph-${hash}-${suffix}.sock`);
		if (Buffer.byteLength(result) > 103) result = join("/tmp", `ralph-${hash}-${suffix}.sock`);
		if (Buffer.byteLength(result) > 103) throw new DriverError("socket-path-too-long", result);
		return result;
	};
	return { eventSocket: path("e"), factSocket: path("f") };
}
async function removeStaleSocket(path: string): Promise<void> {
	if (!existsSync(path)) return;
	const alive = await new Promise<boolean>((resolve, reject) => {
		const socket = connect(path);
		const done = (value: boolean) => { socket.destroy(); resolve(value); };
		socket.setTimeout(1000, () => { socket.destroy(); reject(new DriverError("bind-failed", `Socket probe timed out: ${path}`)); });
		socket.once("connect", () => done(true));
		socket.once("error", (error) => {
			if (code(error) === "ECONNREFUSED" || code(error) === "ENOENT") done(false);
			else { socket.destroy(); reject(new DriverError("bind-failed", String(error))); }
		});
	});
	if (alive) throw new DriverError("driver-active", `Live socket: ${path}`);
	try { unlinkSync(path); } catch (error) { if (code(error) !== "ENOENT") throw error; }
}
async function listen(server: Server, path: string): Promise<void> {
	await removeStaleSocket(path);
	await new Promise<void>((resolve, reject) => {
		const fail = (error: Error) => reject(new DriverError("bind-failed", error.message));
		server.once("error", fail);
		server.listen(path, () => { server.off("error", fail); resolve(); });
	});
}
export class LineServer {
	private readonly server: Server;
	private readonly clients = new Set<Socket>();
	private bound = false;
	readonly path: string;
	constructor(path: string, onLine: (line: string) => void, onBad: () => void = () => {}) {
		this.path = path;
		this.server = createServer((socket) => {
			this.clients.add(socket);
			socket.on("error", () => {});
			socket.on("close", () => this.clients.delete(socket));
			readLines(socket, onLine, 65_536, onBad);
		});
		this.server.on("error", onBad);
	}
	async listen(): Promise<void> { await listen(this.server, this.path); this.bound = true; }
	async close(): Promise<void> {
		for (const socket of this.clients) socket.destroy();
		if (this.bound) { await new Promise<void>((resolve) => this.server.close(() => resolve())); this.bound = false; if (existsSync(this.path)) unlinkSync(this.path); }
	}
}
type LiveFrame = Exclude<EventFrame, { type: "hello" }>;
export type Broadcast = LiveFrame extends infer F ? F extends LiveFrame ? Omit<F, "v" | "seq" | "at"> : never : never;
export class EventServer {
	private readonly server: Server;
	private readonly clients = new Set<Socket>();
	private bound = false;
	nextSeq = 1;
	readonly path: string;
	private readonly hello: () => Extract<EventFrame, { type: "hello" }>;
	private readonly dropped: () => void;
	private readonly now: () => Date;
	constructor(path: string, hello: () => Extract<EventFrame, { type: "hello" }>, dropped: () => void, now: () => Date = () => new Date()) {
		this.hello = hello;
		this.dropped = dropped;
		this.now = now;
		this.path = path;
		this.server = createServer((socket) => {
			socket.on("error", () => this.clients.delete(socket));
			socket.on("close", () => this.clients.delete(socket));
			socket.on("data", () => {});
			this.clients.add(socket);
			this.write(socket, `${JSON.stringify(this.hello())}\n`);
		});
		this.server.on("error", () => {});
	}
	async listen(): Promise<void> { await listen(this.server, this.path); this.bound = true; }
	private write(socket: Socket, line: string): void {
		socket.write(line);
		if (socket.writableLength > SUBSCRIBER_QUEUE_LIMIT_BYTES) { this.clients.delete(socket); socket.destroy(); this.dropped(); }
	}
	publish(frame: Broadcast): void {
		const line = `${JSON.stringify({ v: 1, seq: this.nextSeq++, at: this.now().toISOString(), ...frame })}\n`;
		for (const socket of this.clients) this.write(socket, line);
	}
	async close(): Promise<void> {
		for (const socket of this.clients) socket.end();
		const timer = setTimeout(() => { for (const socket of this.clients) socket.destroy(); }, 100);
		try {
			if (this.bound) { await new Promise<void>((resolve) => this.server.close(() => resolve())); this.bound = false; if (existsSync(this.path)) unlinkSync(this.path); }
		} finally { clearTimeout(timer); }
	}
}
export type DriverMetadata = { readonly v: 1; readonly pid: number; readonly launchId: string; readonly eventSocket: string; readonly factSocket: string; readonly fifo: string; readonly startedAt: string };
export function writeMetadata(root: string, metadata: DriverMetadata): void {
	const path = join(root, ".ralph/driver.json");
	const temporary = `${path}.${process.pid}.tmp`;
	try { writeFileSync(temporary, JSON.stringify(metadata), { mode: 0o600 }); renameSync(temporary, path); }
	finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function readMetadata(root: string): DriverMetadata {
	let value: unknown;
	try { value = JSON.parse(readFileSync(join(root, ".ralph/driver.json"), "utf8")); }
	catch { throw new ControlError("no-driver", "Driver metadata is missing or invalid"); }
	if (!object(value) || value.v !== 1 || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.launchId !== "string" || typeof value.eventSocket !== "string" || typeof value.factSocket !== "string" || typeof value.fifo !== "string" || typeof value.startedAt !== "string" || !isAlive(value.pid)) throw new ControlError("no-driver", "Driver is not live");
	return { v: 1, pid: value.pid, launchId: value.launchId, eventSocket: value.eventSocket, factSocket: value.factSocket, fifo: value.fifo, startedAt: value.startedAt };
}
function validFact(value: unknown): value is LoopFact {
	if (!object(value) || !object(value.run) || (value.run.launchId !== null && typeof value.run.launchId !== "string") || typeof value.run.loopToken !== "string" || typeof value.run.startedAt !== "string" || !Number.isSafeInteger(value.iteration) || Number(value.iteration) < 1 || typeof value.at !== "string") return false;
	switch (value.kind) {
		case "iteration-start": return includes(ITERATION_START_PHASES, value.phase);
		case "iteration-end": return value.outcome === "NEXT";
		case "promise-decision": return includes(CONTROL_PROMISES, value.promise) && typeof value.accepted === "boolean" && (value.reason === null || typeof value.reason === "string");
		case "loop-ended": return value.reason === null || includes(STOP_REASONS, value.reason);
		default: return false;
	}
}
export function parseFact(line: string): LoopFactEnvelope | null {
	let value: unknown;
	try { value = JSON.parse(line); } catch { return null; }
	if (!object(value) || value.version !== 1 || typeof value.id !== "string" || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !validFact(value.fact)) return null;
	return { version: 1, id: value.id, sequence: Number(value.sequence), fact: value.fact };
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function validTool(value: unknown): value is ToolEntry {
	if (!object(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.label !== "string" || (value.startedAt !== null && typeof value.startedAt !== "string")) return false;
	return value.endedAt === null || (typeof value.endedAt === "string" && (value.ms === null || finite(value.ms)) && typeof value.error === "boolean");
}
function validUsage(value: unknown): value is IterationTotals {
	return object(value) && ["input", "output", "cacheRead", "cacheWrite", "costUsd", "messages", "dialogsCancelled", "refusals"].every((key) => finite(value[key]));
}
function validEvent(value: unknown): value is DriverEvent {
	if (!object(value)) return false;
	switch (value.kind) {
		case "activity": return true;
		case "tool-start": case "tool-end": return validTool(value.tool);
		case "assistant-end": return object(value.usage) && ["input", "output", "cacheRead", "cacheWrite"].every((key) => object(value.usage) && finite(value.usage[key])) && finite(value.costUsd) && (value.stopReason === null || typeof value.stopReason === "string") && (value.model === null || typeof value.model === "string");
		case "dialog-cancelled": return typeof value.method === "string" && (value.title === null || typeof value.title === "string");
		case "refusal": return typeof value.tool === "string" && typeof value.text === "string";
		case "fact": return validFact(value.fact);
		default: return false;
	}
}
function validFrame(value: unknown): value is EventFrame {
	if (!object(value) || value.v !== 1) return false;
	if (value.type === "hello") {
		return typeof value.launchId === "string" && Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && Number.isSafeInteger(value.nextSeq) && Number(value.nextSeq) > 0 && (value.lastPiAt === null || typeof value.lastPiAt === "string") && (value.loop === null || (object(value.loop) && typeof value.loop.token === "string" && typeof value.loop.startedAt === "string" && Number.isSafeInteger(value.loop.iteration) && Number(value.loop.iteration) > 0)) && Array.isArray(value.tools) && value.tools.length <= 200 && value.tools.every(validTool) && validUsage(value.totals) && object(value.counters) && ["dialogsCancelled", "refusals", "badRecords", "badFacts", "subscriberDrops"].every((key) => object(value.counters) && finite(value.counters[key])) && ["starting", "ready", "launched", "closing"].includes(String(value.state));
	}
	if (!Number.isSafeInteger(value.seq) || Number(value.seq) < 1 || typeof value.at !== "string") return false;
	switch (value.type) {
		case "event": return validEvent(value.event);
		case "gap": return value.source === "facts" && Number.isSafeInteger(value.from) && Number.isSafeInteger(value.to) && Number(value.from) > 0 && Number(value.to) >= Number(value.from);
		case "lifecycle": return ["ready", "launched", "launch-failed", "pi-exited", "closed"].includes(String(value.state)) && (value.code === undefined || value.code === null || finite(value.code)) && (value.detail === undefined || typeof value.detail === "string");
		case "ack": return typeof value.id === "string" && ["stop", "steer", "go"].includes(String(value.op)) && ["accepted", "completed", "rejected"].includes(String(value.phase)) && (value.reason === undefined || typeof value.reason === "string") && (value.duplicate === undefined || typeof value.duplicate === "boolean");
		default: return false;
	}
}
export function parseEventFrame(line: string): EventFrame | null {
	try { const value: unknown = JSON.parse(line); return validFrame(value) ? value : null; } catch { return null; }
}
