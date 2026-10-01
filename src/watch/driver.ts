import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { FACT_SOCKET_ENV, LAUNCH_ID_ENV } from "../loop/watch-events.js";
import { ControlHandler, type StopAuthority } from "./driver-control.js";
import { FactTracker } from "./driver-facts.js";
import { JournalWriter } from "./journal.js";
import { PiRpc, RpcMonitor, PI_READY_TIMEOUT_MS, PI_SHUTDOWN_GRACE_MS } from "./rpc.js";
import { acquireLock, ControlError, DriverError, ensureFifo, EventServer, LineServer, parseEventFrame, readFifo, readMetadata, socketPaths, writeFifo, writeMetadata, type Broadcast, type Envelope } from "./transport.js";
import { randomUUID as foreignSession } from "node:crypto";
import { isLoopOwnerActive } from "../loop/ownership.js";
import { readStateDocument } from "../state.js";
import { openLoop } from "./loop-state.js";
import type { Control, DriverState, EventFrame, JournalRecord, LoopReader, LoopSnapshot, Mission, Receipt, RunKey } from "./types.js";

export { ControlError, DriverError, FIFO_ENVELOPE_MAX_BYTES, SUBSCRIBER_QUEUE_LIMIT_BYTES } from "./transport.js";
export { TOOL_BUFFER_CALLS, PI_READY_TIMEOUT_MS, PI_SHUTDOWN_GRACE_MS } from "./rpc.js";
export { JOURNAL_CAP_BYTES } from "./journal.js";
export type LaunchGate = (signal: AbortSignal) => Promise<void>;
export type LaunchMode = "fresh" | "relaunch" | "resume";
/**
 * `managed` is the `ralph launch` lifecycle: once the launch prompt is
 * dispatched, a loop may be running even without a fact, so stop and launch
 * failure send `/ralph-stop` and pi is closed only after a fresh state read
 * proves the loop stopped. The default keeps the T8 contract, which closes pi
 * on any launch failure.
 */
export type LaunchSpec = { readonly mission: Mission; readonly launchId: string; readonly gate: LaunchGate; readonly mode?: LaunchMode; readonly lifecycle?: "default" | "managed" };
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
	/** Managed lifecycle: interval between terminal-state reads. */
	readonly terminalPollMs?: number;
};
/** Approximate observer refresh cadence; a cadence, not a limit. */
export const TERMINAL_POLL_MS = 2_000;
/**
 * Reason a launch must not dispatch: incomplete state, or a running loop with a
 * live owner. Any owner is foreign before this launch dispatches, so a fresh
 * session identity checks it, including legacy session-file evidence.
 */
export function activeOwnerConflict(root: string): string | null {
	const document = readStateDocument(root);
	if (document.status === "partial") return `Loop state is incomplete (${document.reason}); it cannot authorize a launch`;
	if (document.status === "valid" && document.state.running && isLoopOwnerActive(document.state, `ralph-launch-${foreignSession()}`)) return "A Ralph loop is running with a live owner";
	return null;
}
/** True only for fresh, valid state of the given loop with running=false. */
export function isTerminal(snapshot: LoopSnapshot, loop: { readonly token: string; readonly startedAt: string }): boolean {
	const state = snapshot.state;
	return snapshot.sources.state.status === "fresh" && state !== null && !state.running && state.loop_token === loop.token && state.started_at === loop.startedAt;
}
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
			return { id, run, phase: next.value.phase, ...(next.value.reason ? { reason: next.value.reason } : {}) };
		}
	} finally {
		await iterator.return?.();
		if (textPath && (!sent || acknowledged) && existsSync(textPath)) unlinkSync(textPath);
	}
}
export function controlLoop(target: ControlTarget, command: Control, signal?: AbortSignal): Promise<Receipt> { return sendControl(target, command, signal); }
export async function releaseLaunch(target: { root: string; launchId: string }, signal?: AbortSignal): Promise<void> {
	const receipt = await sendControl({ root: target.root, run: { launchId: target.launchId, loopToken: null, startedAt: null } }, { kind: "go" }, signal);
	// An aborted wait returns `sent`; only an acknowledgement releases the launch.
	if (receipt.phase === "sent") throw signal?.reason instanceof Error ? signal.reason : abortError();
}

export async function runDriver(spec: LaunchSpec, runtime: DriverRuntime = {}): Promise<DriverExit> {
	let root: string;
	try { root = realpathSync(spec.mission.root); if (!lstatSync(join(root, ".ralph")).isDirectory()) throw new Error("missing .ralph"); }
	catch { throw new DriverError("not-a-ralph-root", "Driver requires an existing .ralph directory"); }
	const releaseLock = acquireLock(root);
	const now = runtime.now ?? (() => new Date());
	const log = runtime.log ?? console.error;
	const abort = new AbortController();
	const managed = spec.lifecycle === "managed";
	const mode = spec.mode ?? "fresh";
	let dispatched = false;
	let piExited = false;
	let failing = false;
	let terminalPoll: ReturnType<typeof setTimeout> | undefined;
	// After dispatch a managed driver turns this into a graceful stop (see finish).
	const onAbort = () => finish("aborted");
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
	/**
	 * The only termination boundary. A managed driver that dispatched its launch
	 * closes pi only after terminal proof or after pi itself exited; every other
	 * failure route becomes a graceful stop that keeps control available.
	 */
	function finish(reason: DriverExit["reason"], code: number | null = null, detail: string | null = null, proven = false): void {
		if (finished) return;
		if (managed && dispatched && !proven && !piExited) { failLaunch(detail ?? reason); return; }
		finished = true; resolveExit({ reason, code, detail }); abort.abort();
	}
	const base = () => ({ v: 1 as const, t: now().toISOString(), r: spec.launchId });
	function driverFact(e: Extract<JournalRecord, { k: "d" }>["e"], why?: string, c?: number | null): void { journal?.append({ ...base(), k: "d", e, ...(why ? { why: why.slice(0, 100) } : {}), ...(c !== undefined ? { c } : {}) }); }
	const monitor = new RpcMonitor((event) => events?.publish({ type: "event", event }), now);
	const publish = (frame: Broadcast) => events?.publish(frame);
	function checkSettled(): void {
		clearTimeout(settleTimer);
		if (!ended || finished) return;
		if (monitor.settled) settledEnd();
		else settleTimer = setTimeout(settledEnd, runtime.settleTimeoutMs ?? 5000);
	}
	function settledEnd(): void {
		if (!managed) finish("loop-finished");
		else awaitTerminal();
	}
	/** Managed: poll loop state; only fresh running=false for the known loop ends the driver. */
	const owned: { reader: LoopReader | null } = { reader: null };
	function awaitTerminal(): void {
		if (finished || terminalPoll !== undefined) return;
		const poll = async () => {
			if (!tracker.loop && !ownLoop) stopAuthority();
			const loop = tracker.loop ?? ownLoop;
			if (finished) return;
			try {
				owned.reader ??= openLoop(root);
				const snapshot = await owned.reader.read(abort.signal);
				if (loop && isTerminal(snapshot, loop)) { finish(!failing ? "loop-finished" : launched ? "aborted" : "launch-rejected", null, failDetail, true); return; }
			} catch (error) { if (!finished) log(`state: ${String(error)}`); }
			if (!finished) terminalPoll = setTimeout(() => void poll(), runtime.terminalPollMs ?? TERMINAL_POLL_MS);
		};
		terminalPoll = setTimeout(() => void poll(), 0);
	}
	let failDetail: string | null = null;
	/** This launch's loop learned from state its own pi owns, when no fact named it. */
	let ownLoop: { token: string; startedAt: string } | null = null;
	/**
	 * Who owns the loop that pi's workspace-wide `/ralph-stop` would stop. Ours:
	 * our facts name it, or its owner is our pi process. Foreign: another live
	 * owner. None: nothing runs. Unknown: incomplete state or a stale owner.
	 */
	function stopAuthority(): StopAuthority {
		const document = readStateDocument(root);
		if (document.status === "partial") return { kind: "unknown", detail: `loop state is incomplete (${document.reason})` };
		const current = document.status === "valid" ? document.state : null;
		if (!current?.running) return tracker.loop ? { kind: "ours" } : { kind: "none" };
		const loop = { token: current.loop_token, startedAt: current.started_at };
		if (current.owner_pid !== null && current.owner_pid === rpc?.child.pid) { ownLoop ??= loop; return { kind: "ours" }; }
		if (tracker.loop && tracker.loop.token === loop.token && tracker.loop.startedAt === loop.startedAt) return { kind: "ours" };
		if (isLoopOwnerActive(current, `ralph-launch-${foreignSession()}`)) return { kind: "foreign", detail: `loop ${loop.token} has a live owner outside this launch` };
		return { kind: "unknown", detail: `loop ${loop.token} runs without a live owner` };
	}
	let stopRetry: ReturnType<typeof setTimeout> | undefined;
	/** Send `/ralph-stop` only under this launch's authority; recheck while it is unknown. */
	function requestStop(): void {
		if (finished) return;
		const authority = stopAuthority();
		if (authority.kind === "ours" || authority.kind === "none") { controls.receive("/ralph-stop"); return; }
		if (authority.kind === "foreign") {
			// pi kept: its state is uncertain and the foreign run must not be stopped.
			log(`launch failed; no stop sent: ${authority.detail}`);
			publish({ type: "lifecycle", state: "launch-failed", detail: `no stop sent: ${authority.detail}`.slice(0, 200) });
			return;
		}
		stopRetry = setTimeout(requestStop, runtime.terminalPollMs ?? TERMINAL_POLL_MS);
	}
	/** Managed launch failure after dispatch: request a graceful stop and keep control available. */
	function failLaunch(detail: string): void {
		if (!managed || !dispatched) { finish("launch-rejected", null, detail); return; }
		if (failing || finished) return;
		failing = true; failDetail = detail; tracker.cancelLaunch();
		publish({ type: "lifecycle", state: "launch-failed", detail: detail.slice(0, 200) });
		requestStop();
		awaitTerminal();
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
		stopBeforeLaunch: () => {
			// After a managed dispatch a loop may already run without a fact yet: send /ralph-stop.
			if (managed && dispatched) return null;
			finish("stopped-before-launch"); return "not-launched";
		},
		// A lost loop-ended fact must not keep a managed driver alive once state proves the stop.
		stopAccepted: () => { if (managed) awaitTerminal(); },
		stopAuthority,
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
		void rpc.exited.then((code) => { piExited = true; driverFact("pi-exit", undefined, code); if (ready) events?.publish({ type: "lifecycle", state: "pi-exited", code }); finish(ready ? "pi-exited" : "pi-not-ready", code); });
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
		// The launcher checked the owner before startup; a loop can start while the driver waits at its gate.
		const conflict = managed && !finished ? activeOwnerConflict(root) : null;
		if (conflict) finish("launch-rejected", null, conflict);
		if (!finished) {
			if (spec.mission.task.kind === "plain" && /--max-iterations/i.test(spec.mission.task.prompt)) finish("launch-rejected", null, "Plain prompt contains reserved --max-iterations option");
			else {
				const task = spec.mission.task.kind === "bundle" ? '"@.ralph/prompt.md"' : spec.mission.task.prompt;
				// Resume keeps the saved budget; it may start a new pi session (initialized) or reuse one (resumed).
				const message = mode === "resume" ? "/ralph-resume" : `/ralph-loop ${task} --max-iterations=${spec.mission.run.maxIterations}`;
				tracker.expectLaunch(mode === "resume" ? ["initialized", "entered", "resumed"] : ["initialized", "entered"]);
				let answered = false;
				// Ralph's own refusals come before its answer; later error notifies belong to other work.
				monitor.onErrorNotify = (notice) => { if (!answered && tracker.launchPending) finish("launch-rejected", null, notice); };
				const limit = runtime.launchTimeoutMs ?? LAUNCH_CONFIRM_TIMEOUT_MS;
				dispatched = true;
				// The bound starts at dispatch so a silent answer cannot hold the launch open.
				launchTimer = setTimeout(() => { if (tracker.launchPending) failLaunch(`No iteration-start fact within ${limit} ms`); }, limit);
				const response = await Promise.race([rpc.send({ type: "prompt", message }, () => { answered = true; monitor.onErrorNotify = () => {}; }).catch(() => null), terminal.then(() => null)]);
				if (!finished && !response?.success && !failing) { clearTimeout(launchTimer); tracker.cancelLaunch(); finish("launch-rejected", null, response?.error ?? "Pi rejected launch"); }
			}
		}
		exit = await terminal;
	} catch (error) {
		if (!rpc) throw error;
		finish("aborted", null, String(error)); exit = await terminal;
	} finally {
		clearTimeout(settleTimer); clearTimeout(launchTimer); clearTimeout(terminalPoll); clearTimeout(stopRetry); await owned.reader?.close().catch(() => {}); runtime.signal?.removeEventListener("abort", onAbort); abort.abort();
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
