import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readStateDocument } from "../state.js";
import { loadMission } from "./config.js";
import { activeOwnerConflict, connectEvents, controlLoop, fifoGate, isTerminal, releaseLaunch, runDriver, TERMINAL_POLL_MS, type DriverExit, type DriverRuntime, type LaunchMode } from "./driver.js";
import { readHostRecord, removeHostRecord, writeHostRecord, type Host, type HostHandle } from "./host.js";
import { tmuxHost } from "./hosts/tmux.js";
import { object } from "./journal.js";
import { openLoop } from "./loop-state.js";
import { acquireLock, ControlError, isAlive, readMetadata } from "./transport.js";
import type { EventFrame, LoopReader, LoopSnapshot, RunKey } from "./types.js";

/** Owner decisions on #10. */
export const LAUNCH_READY_TIMEOUT_MS = 30_000;
export const LAUNCH_FACT_TIMEOUT_MS = 30_000;
export const STOP_ACK_TIMEOUT_MS = 15_000;
/** Readiness metadata poll cadence. */
const READY_POLL_MS = 100;

export type Request =
	| { readonly kind: "launch"; readonly root: string; readonly mode: LaunchMode }
	| { readonly kind: "stop"; readonly root: string; readonly timeoutMs: number | null };
export type Outcome = { readonly ok: true; readonly handle: HostHandle | null } | { readonly ok: false; readonly error: string };
export type CommandRuntime = {
	readonly host?: Host;
	readonly out?: (line: string) => void;
	readonly err?: (line: string) => void;
	readonly signal?: AbortSignal;
	readonly env?: NodeJS.ProcessEnv;
	/** Role command for the hidden driver; the default runs this package's `ralph _driver`. */
	readonly driverArgv?: (manifest: string) => readonly string[];
	readonly readyTimeoutMs?: number;
	readonly factTimeoutMs?: number;
	readonly stopAckTimeoutMs?: number;
	readonly pollMs?: number;
};

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
	if (signal?.aborted) { reject(signal.reason); return; }
	const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
	const abort = () => { clearTimeout(timer); reject(signal!.reason); };
	signal?.addEventListener("abort", abort, { once: true });
});
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const deadline = (ms: number, signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

type Manifest = { readonly v: 1; readonly launchId: string; readonly root: string; readonly mode: LaunchMode; readonly configHash: string };
const manifestPath = (root: string, launchId: string) => join(root, ".ralph", `launch-${launchId}.json`);
function writeManifest(manifest: Manifest): string {
	const path = manifestPath(manifest.root, manifest.launchId);
	const temporary = `${path}.${process.pid}.tmp`;
	try { writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
	finally { if (existsSync(temporary)) unlinkSync(temporary); }
	return path;
}
function readManifest(path: string): Manifest {
	if (!lstatSync(path).isFile()) throw new Error(`Launch manifest is not a regular file: ${path}`);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	let value: unknown;
	try { if (!fstatSync(fd).isFile()) throw new Error("Launch manifest is not a regular file"); value = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
	if (!object(value) || value.v !== 1 || typeof value.launchId !== "string" || typeof value.root !== "string" || typeof value.configHash !== "string" || !["fresh", "relaunch", "resume"].includes(String(value.mode))) throw new Error(`Launch manifest is malformed: ${path}`);
	return value as Manifest;
}

/** Hidden `ralph _driver <manifest>` role: the managed driver for exactly the pinned mission. */
export async function runDriverRole(path: string, runtime: DriverRuntime = {}): Promise<DriverExit> {
	const manifest = readManifest(path);
	const mission = await loadMission(manifest.root);
	if (mission.root !== manifest.root || mission.configHash !== manifest.configHash) throw new Error("Mission changed after launch preflight; launch again");
	return runDriver({ mission, launchId: manifest.launchId, gate: fifoGate(mission.root, manifest.launchId), mode: manifest.mode, lifecycle: "managed" }, { readyTimeoutMs: LAUNCH_READY_TIMEOUT_MS, ...runtime });
}

const defaultDriverArgv = (manifest: string) => [process.execPath, fileURLToPath(new URL("./ralph.mjs", import.meta.url)), "_driver", manifest];

/** Refuse a launch while any live driver or live loop owner may exist. */
function preflight(root: string, mode: LaunchMode): void {
	const lock = join(root, ".ralph/driver.lock");
	if (existsSync(lock)) {
		const pid = Number(readFileSync(lock, "utf8"));
		if (!Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid)) throw new Error(`A driver is active (${lock})`);
	}
	try { readMetadata(root); throw new Error("A driver is active (driver.json)"); } catch (error) { if (!(error instanceof ControlError)) throw error; }
	const conflict = activeOwnerConflict(root);
	if (conflict) throw new Error(conflict);
	const document = readStateDocument(root);
	if (mode === "resume") {
		if (document.status !== "valid") throw new Error("No resumable loop state in .ralph/loop.md");
		const state = document.state;
		if (state.stop_reason === "complete") throw new Error("Loop already completed; use --relaunch");
		if (state.iteration > state.max_iterations) throw new Error("Saved loop is past its iteration budget; use --relaunch");
	}
}

async function waitReady(root: string, launchId: string, host: Host, handle: HostHandle, signal: AbortSignal): Promise<void> {
	while (true) {
		if (signal.aborted) throw signal.reason;
		try {
			const metadata = readMetadata(root);
			if (metadata.launchId !== launchId) throw new Error("Another driver owns this root");
			return;
		} catch (error) { if (!(error instanceof ControlError)) throw error; }
		if (await host.paneDead(handle, signal)) { if (signal.aborted) throw signal.reason; throw new Error("Driver role exited before it was ready"); }
		await sleep(READY_POLL_MS, signal);
	}
}

/** Resolves on the first launch confirmation; rejects on failure, driver loss or the deadline. */
async function waitConfirmed(frames: AsyncIterator<EventFrame>, signal: AbortSignal): Promise<void> {
	while (true) {
		const next = await frames.next();
		if (signal.aborted) throw new Error("No launch confirmation within the fact deadline");
		if (next.done) throw new Error("Driver closed before the launch was confirmed");
		const frame = next.value;
		// The confirmation may precede the subscription; hello then carries it.
		if (frame.type === "hello" && frame.state === "launched") return;
		if (frame.type === "lifecycle") {
			if (frame.state === "launched") return;
			if (frame.state === "launch-failed" || frame.state === "closed" || frame.state === "pi-exited") throw new Error(`Launch failed: ${frame.detail ?? frame.state}`);
		}
	}
}

/**
 * A host record left by natural completion or a crash must not block the next
 * launch. Preflight already proved that no driver and no live owner exist; the
 * old session closes only when it verifies and its role has exited. A live or
 * uncertain session is refused.
 */
async function recoverInactiveHost(root: string, host: Host, signal: AbortSignal): Promise<void> {
	const previous = readHostRecord(root);
	if (!previous) return;
	if (await host.verify(previous, signal)) {
		if (!await host.paneDead(previous, signal)) throw new Error(`tmux session ${previous.name} (${previous.sessionId}) of launch ${previous.launchId} still runs a process; inspect or close it first`);
		if (signal.aborted) throw signal.reason;
		await host.close(previous);
	}
	removeHostRecord(root, previous.launchId);
	const manifest = manifestPath(root, previous.launchId);
	if (existsSync(manifest)) unlinkSync(manifest);
}

async function launch(request: Extract<Request, { kind: "launch" }>, runtime: CommandRuntime): Promise<Outcome> {
	const err = runtime.err ?? console.error;
	const mission = await loadMission(request.root);
	const root = mission.root;
	if (!mission.host.prefer.includes("tmux")) throw new Error("Mission host preference excludes tmux, the only supported host");
	const releaseLock = acquireLock(root, "launch.lock");
	const launchId = randomUUID();
	let handle: HostHandle | null = null;
	let dispatched = false;
	try {
		preflight(root, request.mode);
		const host = runtime.host ?? tmuxHost({ env: runtime.env });
		const manifest = writeManifest({ v: 1, launchId, root, mode: request.mode, configHash: mission.configHash });
		const env = runtime.env ?? process.env;
		const blocked = [...new Set(["ask_user", ...[env.RALPH_BLOCKED_TOOLS, env.RALPH_EXTRA_BLOCKED_TOOLS].flatMap((list) => (list ?? "").split(",")).map((tool) => tool.trim()).filter(Boolean)])].join(",");
		const readyMs = runtime.readyTimeoutMs ?? LAUNCH_READY_TIMEOUT_MS;
		// One absolute readiness deadline covers host startup and the driver's ready metadata.
		const ready = deadline(readyMs, runtime.signal);
		const notReady = () => runtime.signal?.aborted ? new Error("Launch aborted before dispatch") : new Error(`Driver not ready within ${readyMs / 1000} s`);
		try {
			await recoverInactiveHost(root, host, ready);
			handle = await host.open(root, launchId, { title: "loop", argv: (runtime.driverArgv ?? defaultDriverArgv)(manifest), env: { PATH: env.PATH ?? "", PI_SUBAGENT_MUX: "tmux", RALPH_BLOCKED_TOOLS: blocked } }, ready);
		} catch (error) { if (existsSync(manifest)) unlinkSync(manifest); throw ready.aborted ? notReady() : error; }
		try {
			writeHostRecord(handle);
			err(`ralph: waiting for driver in tmux session ${handle.name} (${handle.sessionId})`);
			await waitReady(root, launchId, host, handle, ready);
		} catch (error) {
			// Nothing was dispatched: the unused session holds no loop.
			if (await host.verify(handle)) await host.close(handle);
			removeHostRecord(root, launchId);
			if (existsSync(manifest)) unlinkSync(manifest);
			throw ready.aborted ? notReady() : error;
		}
		const watch = new AbortController();
		const frames = connectEvents({ root, run: { launchId, loopToken: null, startedAt: null } }, watch.signal)[Symbol.asyncIterator]();
		try {
			const first = frames.next();
			// From here the go command may reach the driver: failure must stop gracefully, never close.
			dispatched = true;
			await releaseLaunch({ root, launchId }, ready);
			const factDeadline = deadline(runtime.factTimeoutMs ?? LAUNCH_FACT_TIMEOUT_MS, runtime.signal);
			const onDeadline = () => watch.abort();
			factDeadline.addEventListener("abort", onDeadline, { once: true });
			try {
				const iterator: AsyncIterator<EventFrame> = { next: (() => { let pending: Promise<IteratorResult<EventFrame>> | null = first; return () => { const value = pending ?? frames.next(); pending = null; return value; }; })() };
				await waitConfirmed(iterator, factDeadline);
			} finally { factDeadline.removeEventListener("abort", onDeadline); }
		} finally { watch.abort(); await frames.return?.(); }
		return { ok: true, handle };
	} catch (error) {
		if (dispatched) {
			err("ralph: launch failed after dispatch; requesting a graceful stop");
			try { await controlLoop({ root, run: { launchId, loopToken: null, startedAt: null } }, { kind: "stop" }, AbortSignal.timeout(runtime.stopAckTimeoutMs ?? STOP_ACK_TIMEOUT_MS)); }
			catch (stopError) { err(`ralph: stop request failed: ${message(stopError)}; run ralph stop ${root}`); }
		}
		throw error;
	} finally { releaseLock(); }
}

function progress(snapshot: LoopSnapshot, waitedMs: number): string {
	const waited = `${Math.round(waitedMs / 1000)} s`;
	const state = snapshot.state;
	if (!state) return `ralph: stopping; state unavailable (${snapshot.issues.find((issue) => issue.source === "state")?.detail ?? snapshot.sources.state.error ?? "unknown"}); waited ${waited}`;
	return `ralph: stopping; iteration ${state.iteration}/${state.max_iterations}, running=${state.running}, stop_requested=${state.stop_requested}; waited ${waited}`;
}

async function stop(request: Extract<Request, { kind: "stop" }>, runtime: CommandRuntime): Promise<Outcome> {
	const err = runtime.err ?? console.error;
	const root = realpathSync.native(request.root);
	let launchId: string;
	try { launchId = readMetadata(root).launchId; }
	catch (error) { if (error instanceof ControlError) throw new Error(`No live driver for ${root}; the loop state was not changed`); throw error; }
	const pinned: RunKey = { launchId, loopToken: null, startedAt: null };
	const ackMs = runtime.stopAckTimeoutMs ?? STOP_ACK_TIMEOUT_MS;
	let receipt;
	try { receipt = await controlLoop({ root, run: pinned }, { kind: "stop" }, deadline(ackMs, runtime.signal)); }
	catch (error) {
		if (error instanceof DOMException || runtime.signal?.aborted) throw new Error(`No stop acknowledgement within ${ackMs / 1000} s; the stop may already have been sent`);
		throw new Error(`Stop failed: ${message(error)}`);
	}
	if (receipt.phase === "sent") throw new Error(`No stop acknowledgement within ${ackMs / 1000} s; the stop may already have been sent`);
	const wait = request.timeoutMs === null ? runtime.signal : deadline(request.timeoutMs, runtime.signal);
	const started = Date.now();
	const waited = () => `${Math.round((Date.now() - started) / 1000)} s`;
	const stillStopping = () => new Error(`Loop still stopping after ${waited()}; the host was left open`);
	const host = runtime.host ?? tmuxHost({ env: runtime.env });
	const poll = () => sleep(runtime.pollMs ?? TERMINAL_POLL_MS, wait).catch(() => {});
	/** Wait for the driver role to exit so the session holds no process when it closes. */
	async function roleExited(handle: HostHandle): Promise<void> {
		while (!await host.paneDead(handle, wait)) {
			if (wait?.aborted) throw stillStopping();
			err(`ralph: loop stopped; waiting for the driver to exit; waited ${waited()}`);
			await poll();
		}
		if (wait?.aborted) throw stillStopping();
	}
	if (receipt.phase === "completed" && receipt.reason === "not-launched") {
		// Stopped before dispatch: the driver closes its idle pi and no loop ever ran in this session.
		err("ralph: stopped before launch");
		const handle = readHostRecord(root);
		if (!handle || handle.launchId !== launchId) return { ok: true, handle: null };
		await roleExited(handle);
		if (!await host.verify(handle)) throw new Error(`tmux session ${handle.sessionId} no longer matches this launch; left open`);
		await host.close(handle);
		forget(root, launchId);
		return { ok: true, handle };
	}
	err(`ralph: stop ${receipt.phase}; waiting for running=false`);
	// Terminal proof needs this launch's loop identity, which only its own facts provide.
	let loop = receipt.run.loopToken && receipt.run.startedAt ? { token: receipt.run.loopToken, startedAt: receipt.run.startedAt } : null;
	const reader = openLoop(root);
	let driverGone = false;
	try {
		while (true) {
			if (wait?.aborted) throw stillStopping();
			loop ??= await driverLoop(root, launchId, wait);
			let snapshot: LoopSnapshot;
			try { snapshot = await reader.read(wait); }
			catch (error) { if (wait?.aborted) continue; throw error; }
			if (loop && isTerminal(snapshot, loop)) break;
			// The managed driver exits only after terminal proof or pi exit; allow one more read for teardown order.
			let live = true;
			try { live = readMetadata(root).launchId === launchId; } catch { live = false; }
			if (!live && driverGone) throw new Error(loop ? "Driver exited while the loop state is not terminal; the host was left open" : "Driver exited before this launch reported its loop; the stop cannot be proven and the host was left open");
			driverGone = !live;
			err(loop ? progress(snapshot, Date.now() - started) : `ralph: stopping; waiting for this launch's first loop fact; waited ${waited()}`);
			await poll();
		}
		const handle = readHostRecord(root);
		if (!handle || handle.launchId !== launchId) return { ok: true, handle: null };
		await roleExited(handle);
		await closeIdle(host, handle, reader, loop);
		forget(root, launchId);
		return { ok: true, handle };
	} finally { await reader.close(); }
}

/** This launch's loop identity from the live driver, or null while it has none or is gone. */
async function driverLoop(root: string, launchId: string, signal?: AbortSignal): Promise<{ token: string; startedAt: string } | null> {
	try {
		for await (const frame of connectEvents({ root, run: { launchId, loopToken: null, startedAt: null } }, signal)) {
			return frame.type === "hello" && frame.loop ? { token: frame.loop.token, startedAt: frame.loop.startedAt } : null;
		}
	} catch { /* Driver gone or changed: no identity. */ }
	return null;
}

/**
 * Guarded idle close: a new fresh read, at the close boundary, must show this
 * launch's loop stopped, and the host record and session must still be this launch's.
 */
async function closeIdle(host: Host, handle: HostHandle, reader: LoopReader, loop: { token: string; startedAt: string }): Promise<void> {
	const snapshot = await reader.read();
	if (!isTerminal(snapshot, loop) || readHostRecord(handle.root)?.launchId !== handle.launchId) throw new Error("Loop state changed after stop; the host was left open");
	if (!await host.verify(handle)) throw new Error(`tmux session ${handle.sessionId} no longer matches this launch; left open`);
	await host.close(handle);
}

function forget(root: string, launchId: string): void {
	removeHostRecord(root, launchId);
	const manifest = manifestPath(root, launchId);
	if (existsSync(manifest)) unlinkSync(manifest);
}

/** Run one launch or stop request. Errors return `ok: false` with a message. */
export async function execute(request: Request, runtime: CommandRuntime = {}): Promise<Outcome> {
	try { return request.kind === "launch" ? await launch(request, runtime) : await stop(request, runtime); }
	catch (error) { return { ok: false, error: message(error) }; }
}
