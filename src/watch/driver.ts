import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { FACT_SOCKET_ENV, LAUNCH_ID_ENV } from "../loop/watch-events.js";
import { ControlHandler } from "./driver-control.js";
import { FactTracker } from "./driver-facts.js";
import { JournalWriter } from "./journal.js";
import { PiRpc, RpcMonitor, PI_READY_TIMEOUT_MS, PI_SHUTDOWN_GRACE_MS } from "./rpc.js";
import { acquireLock, ControlError, DriverError, ensureFifo, EventServer, LineServer, parseEventFrame, readFifo, readMetadata, socketPaths, writeFifo, writeMetadata, type Broadcast, type Envelope } from "./transport.js";
import type { Control, DriverState, EventFrame, JournalRecord, Mission, Receipt, RunKey } from "./types.js";

export { ControlError, DriverError, FIFO_ENVELOPE_MAX_BYTES, SUBSCRIBER_QUEUE_LIMIT_BYTES } from "./transport.js";
export { TOOL_BUFFER_CALLS, PI_READY_TIMEOUT_MS, PI_SHUTDOWN_GRACE_MS } from "./rpc.js";
export { JOURNAL_CAP_BYTES } from "./journal.js";
export type LaunchGate = (signal: AbortSignal) => Promise<void>;
export type LaunchSpec = { readonly mission: Mission; readonly launchId: string; readonly gate: LaunchGate };
export type DriverRuntime = {
	readonly piCommand?: { readonly file: string; readonly args: readonly string[] };
	readonly env?: NodeJS.ProcessEnv;
	readonly tmpDir?: string;
	readonly now?: () => Date;
	readonly signal?: AbortSignal;
	readonly log?: (line: string) => void;
	readonly readyTimeoutMs?: number;
	readonly shutdownGraceMs?: number;
	readonly settleTimeoutMs?: number;
	readonly launchTimeoutMs?: number;
};
/**
 * Launch-readiness limit (owner decision on #9/#10). pi answers `/ralph-loop`
 * with success even when the extension refuses, so launch is confirmed only by
 * the first iteration-start fact within this time.
 */
export const LAUNCH_CONFIRM_TIMEOUT_MS = 30_000;
export type DriverExit = {
	readonly reason: "pi-exited" | "loop-finished" | "stopped-before-launch" | "aborted" | "pi-not-ready" | "launch-rejected";
	readonly code: number | null;
	readonly detail: string | null;
};
const abortError = () => new DOMException("Operation aborted", "AbortError");
const throwIfAborted = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError(); };
const gateReleases = new WeakMap<LaunchGate, { root: string; launchId: string; release: () => void }>();
export const immediateGate: LaunchGate = async () => {};
export function fifoGate(root: string, launchId: string): LaunchGate {
	let release!: () => void;
	const released = new Promise<void>((resolve) => { release = resolve; });
	const gate: LaunchGate = (signal) => new Promise((resolve, reject) => {
		if (signal.aborted) { reject(abortError()); return; }
		const abort = () => reject(abortError());
		signal.addEventListener("abort", abort, { once: true });
		void released.then(() => resolve()).finally(() => signal.removeEventListener("abort", abort));
	});
	gateReleases.set(gate, { root: realpathSync(root), launchId, release });
	return gate;
}

/** Read-only replay then live stream. Pull-based reads leave backpressure local. */
export async function* connectEvents(target: { root: string; run?: RunKey }, signal?: AbortSignal): AsyncIterable<EventFrame> {
	if (signal?.aborted) return;
	const metadata = readMetadata(target.root);
	const socket = connect(metadata.eventSocket);
	const abort = () => socket.destroy();
	signal?.addEventListener("abort", abort, { once: true });
	let buffer = "";
	let first = true;
	let closed = false;
	socket.setEncoding("utf8");
	try {
		for await (const chunk of socket) {
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const frame = parseEventFrame(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (!frame) throw new ControlError("disconnected", "Invalid event frame");
				if (first) {
					if (frame.type !== "hello") throw new ControlError("disconnected", "Missing hello frame");
					if (metadata.launchId !== frame.launchId || (target.run?.launchId != null && target.run.launchId !== frame.launchId) || (target.run?.loopToken != null && target.run.loopToken !== frame.loop?.token)) throw new ControlError("wrong-run", "Driver run changed");
					first = false;
				} else if (frame.type === "hello") throw new ControlError("disconnected", "Unexpected hello frame");
				if (frame.type === "lifecycle" && frame.state === "closed") closed = true;
				yield frame;
				if (closed) return;
			}
		}
		if (!signal?.aborted && !closed) throw new ControlError("disconnected", "Driver event stream closed unexpectedly");
	} catch (error) {
		if (signal?.aborted) return;
		if (error instanceof ControlError) throw error;
		throw new ControlError("disconnected", String(error));
	} finally { signal?.removeEventListener("abort", abort); socket.destroy(); }
}

type ControlTarget = { root: string; run: RunKey };
async function sendControl(target: ControlTarget, command: Control | { kind: "go" }, signal?: AbortSignal): Promise<Receipt> {
	throwIfAborted(signal);
	const iterator = connectEvents(target, signal)[Symbol.asyncIterator]();
	let sent = false;
	let acknowledged = false;
	let textPath: string | null = null;
	try {
		const first = await iterator.next();
		throwIfAborted(signal);
		if (first.done || first.value.type !== "hello") throw new ControlError("disconnected", "No hello from driver");
		const hello = first.value;
		const run: RunKey = { launchId: hello.launchId, loopToken: hello.loop?.token ?? null, startedAt: hello.loop?.startedAt ?? null };
		const id = randomUUID();
		const base = { v: 1 as const, id, launch: hello.launchId, token: run.loopToken };
		let envelope: Envelope;
		if (command.kind === "steer") {
			const directory = join(realpathSync(target.root), ".ralph/steer");
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			if (realpathSync(directory) !== directory) throw new ControlError("rejected", "Steer directory escapes the Ralph root");
			textPath = join(directory, `${id}.txt`);
			writeFileSync(textPath, command.text, { flag: "wx", mode: 0o600 });
			// Relative paths keep envelopes atomic even for deeply nested roots.
			envelope = { ...base, op: "steer", textPath: `.ralph/steer/${id}.txt` };
		} else envelope = { ...base, op: command.kind === "go" ? "go" : "stop" };
		const metadata = readMetadata(target.root);
		if (metadata.launchId !== hello.launchId) throw new ControlError("wrong-run", "Driver changed before send");
		throwIfAborted(signal);
		writeFifo(metadata.fifo, JSON.stringify(envelope));
		sent = true;
		while (true) {
			const next = await iterator.next();
			if (signal?.aborted) return { id, run, phase: "sent" };
			if (next.done) throw new ControlError("disconnected", "Driver disconnected before acknowledgement");
			if (next.value.type !== "ack" || next.value.id !== id) continue;
			acknowledged = true;
			if (next.value.phase === "rejected") throw new ControlError("rejected", next.value.reason ?? "Driver rejected control");
			return { id, run, phase: next.value.phase };
		}
	} finally {
		await iterator.return?.();
		if (textPath && (!sent || acknowledged) && existsSync(textPath)) unlinkSync(textPath);
	}
}
export function controlLoop(target: ControlTarget, command: Control, signal?: AbortSignal): Promise<Receipt> { return sendControl(target, command, signal); }
export async function releaseLaunch(target: { root: string; launchId: string }, signal?: AbortSignal): Promise<void> {
	await sendControl({ root: target.root, run: { launchId: target.launchId, loopToken: null, startedAt: null } }, { kind: "go" }, signal);
}

export async function runDriver(spec: LaunchSpec, runtime: DriverRuntime = {}): Promise<DriverExit> {
	let root: string;
	try { root = realpathSync(spec.mission.root); if (!lstatSync(join(root, ".ralph")).isDirectory()) throw new Error("missing .ralph"); }
	catch { throw new DriverError("not-a-ralph-root", "Driver requires an existing .ralph directory"); }
	const releaseLock = acquireLock(root);
	const now = runtime.now ?? (() => new Date());
	const log = runtime.log ?? console.error;
	const abort = new AbortController();
	const onAbort = () => { abort.abort(); finish("aborted"); };
	let rpc: PiRpc | null = null;
	let fifo: Socket | null = null;
	let events: EventServer | null = null;
	let facts: LineServer | null = null;
	let journal: JournalWriter | null = null;
	let metadataWritten = false;
	let state: DriverState = "starting";
		let launched = false;
	let launchTimer: ReturnType<typeof setTimeout> | undefined;
	let ready = false;
	let finished = false;
	let ended = false;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let resolveExit!: (exit: DriverExit) => void;
	const terminal = new Promise<DriverExit>((resolve) => { resolveExit = resolve; });
	function finish(reason: DriverExit["reason"], code: number | null = null, detail: string | null = null): void {
		if (finished) return;
		finished = true; resolveExit({ reason, code, detail }); abort.abort();
	}
	const base = () => ({ v: 1 as const, t: now().toISOString(), r: spec.launchId });
	function driverFact(e: Extract<JournalRecord, { k: "d" }>["e"], why?: string, c?: number | null): void { journal?.append({ ...base(), k: "d", e, ...(why ? { why: why.slice(0, 100) } : {}), ...(c !== undefined ? { c } : {}) }); }
	const monitor = new RpcMonitor((event) => events?.publish({ type: "event", event }), now);
	const publish = (frame: Broadcast) => events?.publish(frame);
	function checkSettled(): void {
		clearTimeout(settleTimer);
		if (!ended || finished) return;
		if (monitor.settled) finish("loop-finished");
		else settleTimer = setTimeout(() => finish("loop-finished"), runtime.settleTimeoutMs ?? 5000);
	}
	const tracker: FactTracker = new FactTracker({
		launchId: spec.launchId, monitor, journal: () => journal, base, publish, driverFact,
		onLaunched: () => { launched = true; clearTimeout(launchTimer); state = "launched"; publish({ type: "lifecycle", state: "launched" }); driverFact("launched"); },
		onLoopEnded: (token) => { ended = true; controls.loopEnded(token); checkSettled(); },
	});
	const controls: ControlHandler = new ControlHandler({
		root, launchId: spec.launchId, tracker, monitor, rpc: () => rpc, journal: () => journal, base, publish, log,
		finished: () => finished, launched: () => launched,
		releaseGate: () => {
			const gate = gateReleases.get(spec.gate);
			if (!gate || gate.root !== root || gate.launchId !== spec.launchId) return false;
			gate.release(); return true;
		},
		// Before the first fact no loop exists to stop: closing pi ends the launch instead.
		stopBeforeLaunch: () => { finish("stopped-before-launch"); return "not-launched"; },
	});
	let exit: DriverExit | null = null;
	try {
		const fifoPath = ensureFifo(root);
		const paths = socketPaths(root, runtime.tmpDir);
		events = new EventServer(paths.eventSocket, () => ({ v: 1, type: "hello", launchId: spec.launchId, pid: process.pid, nextSeq: events!.nextSeq, lastPiAt: monitor.lastPiAt, loop: tracker.loop, tools: monitor.tools, totals: monitor.totals, counters: monitor.counters, state }), () => { monitor.counters.subscriberDrops++; log("events: dropped subscriber over 1 MB"); }, now);
		facts = new LineServer(paths.factSocket, (line) => tracker.receive(line), () => { monitor.counters.badFacts++; });
		await events.listen(); await facts.listen();
		fifo = readFifo(fifoPath, (line) => controls.receive(line), () => log("FIFO: rejected oversized command"));
		fifo.on("error", (error) => { log(`FIFO: ${String(error)}`); finish("aborted", null, "FIFO reader failed"); });
		journal = new JournalWriter(root, { ...base(), k: "run", m: spec.mission.run.model, th: spec.mission.run.thinking, mx: spec.mission.run.maxIterations, tk: spec.mission.task.kind === "bundle" ? "b" : "p" }, log);
		driverFact("start");
		const env = runtime.env ?? process.env;
		const blocked = [...new Set([...(env.RALPH_BLOCKED_TOOLS ?? "").split(",").map((tool) => tool.trim()).filter(Boolean), "ask_user"])].join(",");
		const command = runtime.piCommand ?? { file: "pi", args: [] };
		rpc = new PiRpc(command.file, [...command.args, "--mode", "rpc", "--model", spec.mission.run.model, "--thinking", spec.mission.run.thinking], { cwd: root, env: { ...env, [FACT_SOCKET_ENV]: paths.factSocket, [LAUNCH_ID_ENV]: spec.launchId, RALPH_BLOCKED_TOOLS: blocked } }, monitor, log, checkSettled);
		void rpc.exited.then((code) => { driverFact("pi-exit", undefined, code); if (ready) events?.publish({ type: "lifecycle", state: "pi-exited", code }); finish(ready ? "pi-exited" : "pi-not-ready", code); });
		runtime.signal?.addEventListener("abort", onAbort, { once: true });
		if (runtime.signal?.aborted) onAbort();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), runtime.readyTimeoutMs ?? PI_READY_TIMEOUT_MS); });
		const readiness = await Promise.race([rpc.send({ type: "get_state" }).catch(() => null), timeoutPromise, terminal.then(() => null)]);
		clearTimeout(timeout);
		if (!readiness?.success && !finished) { driverFact("pi-not-ready"); finish("pi-not-ready"); }
		if (!finished) {
			ready = true; state = "ready";
			writeMetadata(root, { v: 1, pid: process.pid, launchId: spec.launchId, ...paths, fifo: fifoPath, startedAt: now().toISOString() }); metadataWritten = true;
			events.publish({ type: "lifecycle", state: "ready" }); driverFact("ready"); driverFact("gate-wait");
			await Promise.race([spec.gate(abort.signal), terminal]).catch((error) => { if (!finished) finish("launch-rejected", null, String(error)); });
		}
		if (!finished) {
			if (spec.mission.task.kind === "plain" && /--max-iterations/i.test(spec.mission.task.prompt)) finish("launch-rejected", null, "Plain prompt contains reserved --max-iterations option");
			else {
				const task = spec.mission.task.kind === "bundle" ? '"@.ralph/prompt.md"' : spec.mission.task.prompt;
				tracker.expectLaunch(["initialized", "entered"]);
				monitor.onErrorNotify = (message) => { if (tracker.launchPending) finish("launch-rejected", null, message); };
				const response = await Promise.race([rpc.send({ type: "prompt", message: `/ralph-loop ${task} --max-iterations=${spec.mission.run.maxIterations}` }).catch(() => null), terminal.then(() => null)]);
				if (!finished && !response?.success) finish("launch-rejected", null, response?.error ?? "Pi rejected launch");
				else if (!finished && tracker.launchPending) {
					const limit = runtime.launchTimeoutMs ?? LAUNCH_CONFIRM_TIMEOUT_MS;
					launchTimer = setTimeout(() => { if (tracker.launchPending) finish("launch-rejected", null, `No iteration-start fact within ${limit} ms`); }, limit);
				}
			}
		}
		exit = await terminal;
	} catch (error) {
		if (!rpc) throw error;
		finish("aborted", null, String(error)); exit = await terminal;
	} finally {
		clearTimeout(settleTimer); clearTimeout(launchTimer); runtime.signal?.removeEventListener("abort", onAbort); abort.abort();
		state = "closing";
		if (rpc) {
			const code = await rpc.close(runtime.shutdownGraceMs ?? PI_SHUTDOWN_GRACE_MS);
			if (exit && exit.code === null) exit = { ...exit, code };
			tracker.flushUsage(); driverFact("exit", exit?.reason, exit?.code);
			events?.publish({ type: "lifecycle", state: "closed", code, ...(exit?.detail ? { detail: exit.detail } : {}) });
		}
		fifo?.destroy();
		await facts?.close(); await events?.close();
		if (metadataWritten && existsSync(join(root, ".ralph/driver.json"))) unlinkSync(join(root, ".ralph/driver.json"));
		releaseLock();
	}
	return exit!;
}
