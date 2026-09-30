import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join, relative, resolve, isAbsolute } from "node:path";
import { FACT_SOCKET_ENV, LAUNCH_ID_ENV } from "../loop/watch-events.js";
import { JournalWriter, object } from "./journal.js";
import { PiRpc, RpcMonitor, emptyTotals, PI_READY_TIMEOUT_MS, PI_SHUTDOWN_GRACE_MS } from "./rpc.js";
import { acquireLock, ControlError, DriverError, ensureFifo, EventServer, LineServer, parseEnvelope, parseEventFrame, parseFact, readFifo, readMetadata, socketPaths, writeFifo, writeMetadata, type Envelope } from "./transport.js";
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

function readSteer(root: string, path: string): { path: string; text: string } {
	const directory = join(root, ".ralph/steer");
	const resolved = resolve(root, path);
	const inside = relative(directory, resolved);
	if (!inside || inside === ".." || inside.startsWith("../") || isAbsolute(inside) || realpathSync(directory) !== directory || realpathSync(resolved) !== resolved || !lstatSync(resolved).isFile()) throw new ControlError("rejected", "Steer path escapes .ralph/steer or is not a regular file");
	const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if (!fstatSync(fd).isFile()) throw new ControlError("rejected", "Steer path is not a regular file");
		return { path: resolved, text: readFileSync(fd, "utf8") };
	} finally { closeSync(fd); }
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
	let loop: Extract<EventFrame, { type: "hello" }>["loop"] = null;
	let launched = false;
	let launchPending = false;
	let launchTimer: ReturnType<typeof setTimeout> | undefined;
	let ready = false;
	let finished = false;
	let ended = false;
	let released = false;
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
	function flushUsage(): void {
		const totals = monitor.totals;
		if (Object.values(totals).some((value) => value !== 0)) journal?.append({ ...base(), k: "u", tok: loop?.token ?? null, i: loop?.iteration ?? 1, in: totals.input, out: totals.output, cr: totals.cacheRead, cw: totals.cacheWrite, c: Number(totals.costUsd.toFixed(6)), n: totals.messages, dc: totals.dialogsCancelled, pr: totals.refusals });
		monitor.totals = emptyTotals();
	}
	function checkSettled(): void {
		clearTimeout(settleTimer);
		if (!ended || finished) return;
		if (monitor.settled) finish("loop-finished");
		else settleTimer = setTimeout(() => finish("loop-finished"), runtime.settleTimeoutMs ?? 5000);
	}
	const lastSequences = new Map<string, number>();
	const endedTokens = new Set<string>();
	const acceptedStops = new Map<string, Set<string>>();
	const stopResults = new Map<string, Promise<boolean>>();
	function receiveFact(line: string): void {
		const envelope = parseFact(line);
		if (!envelope || envelope.fact.run.launchId !== spec.launchId) { monitor.counters.badFacts++; return; }
		const fact = envelope.fact;
		const key = JSON.stringify([fact.run.launchId, fact.run.loopToken]);
		const last = lastSequences.get(key) ?? 0;
		if (envelope.sequence <= last) return;
		if (envelope.sequence > last + 1) { events?.publish({ type: "gap", source: "facts", from: last + 1, to: envelope.sequence - 1 }); driverFact("gap", `${last + 1}-${envelope.sequence - 1}`); }
		lastSequences.set(key, envelope.sequence);
		if (!loop || loop.token !== fact.run.loopToken || loop.iteration !== fact.iteration) {
			flushUsage(); monitor.resetIteration();
		}
		loop = { token: fact.run.loopToken, startedAt: fact.run.startedAt, iteration: fact.iteration };
		if (fact.kind === "iteration-start" && (fact.phase === "initialized" || fact.phase === "resumed")) journal?.append({ ...base(), k: "loop", tok: loop.token, sa: loop.startedAt, i: loop.iteration, ph: fact.phase });
		if (fact.kind === "promise-decision") journal?.append({ ...base(), k: "g", tok: loop.token, i: loop.iteration, p: fact.promise, ok: fact.accepted ? 1 : 0, ...(fact.reason ? { why: fact.reason.slice(0, 100) } : {}) });
		if (fact.kind === "iteration-end") flushUsage();
		events?.publish({ type: "event", event: { kind: "fact", fact } });
		if (launchPending && fact.kind === "iteration-start" && (fact.phase === "initialized" || fact.phase === "entered")) {
			launchPending = false; launched = true; clearTimeout(launchTimer);
			state = "launched"; events?.publish({ type: "lifecycle", state: "launched" }); driverFact("launched");
		}
		if (fact.kind === "loop-ended") {
			ended = true; endedTokens.add(loop.token);
			for (const id of acceptedStops.get(loop.token) ?? []) events?.publish({ type: "ack", id, op: "stop", phase: "completed" });
			checkSettled();
		}
	}
	async function control(envelope: Envelope | null): Promise<void> {
		const op = envelope?.op ?? "stop";
		const id = envelope?.id ?? null;
		const token = loop?.token ?? "pre-loop";
		const ack = (phase: "accepted" | "completed" | "rejected", reason?: string, duplicate?: boolean) => { if (id) events?.publish({ type: "ack", id, op, phase, ...(reason ? { reason } : {}), ...(duplicate ? { duplicate } : {}) }); };
		const intervention = (ok: boolean, why?: string, txt?: string) => { if (op !== "go") journal?.append({ ...base(), k: "x", op, id, ok: ok ? 1 : 0, ...(why ? { why: why.slice(0, 100) } : {}), ...(txt !== undefined ? { txt } : {}) }); };
		if (envelope && (envelope.launch !== spec.launchId || (envelope.token !== null && envelope.token !== loop?.token))) { ack("rejected", "wrong-run"); return; }
		if (op === "go") {
			const gate = gateReleases.get(spec.gate);
			if (!gate || gate.root !== root || gate.launchId !== spec.launchId) { ack("rejected", "no-fifo-gate"); return; }
			gate.release(); ack("accepted", undefined, released); released = true; return;
		}
		if (op === "steer" && envelope?.op === "steer") {
			let steer: { path: string; text: string };
			try { steer = readSteer(root, envelope.textPath); } catch (error) { ack("rejected", String(error)); intervention(false, "invalid-steer-path"); return; }
			try {
				if (!launched || finished || !rpc) { intervention(false, "not-launched", steer.text); ack("rejected", "not-launched"); return; }
				// pi queues a steer even while idle; it would reach a later iteration or be lost.
				if (monitor.settled) { intervention(false, "not-streaming", steer.text); ack("rejected", "not-streaming"); return; }
				const response = await rpc.send({ type: "steer", message: steer.text });
				intervention(response.success, response.error ?? undefined, steer.text);
				ack(response.success ? "accepted" : "rejected", response.error ?? undefined);
			} catch (error) { intervention(false, String(error), steer.text); ack("rejected", String(error)); }
			finally { try { unlinkSync(steer.path); } catch (error) { log(`steer cleanup: ${String(error)}`); } }
			return;
		}
		// Before the first fact no loop exists to stop: closing pi ends the launch instead.
		if (!launched) { intervention(true, "not-launched"); ack("completed", "not-launched"); finish("stopped-before-launch"); return; }
		if (endedTokens.has(token)) { intervention(true, "already-ended"); ack("completed"); return; }
		const duplicate = stopResults.has(token);
		let pending = stopResults.get(token);
		if (!pending) {
			pending = (async () => { try { return (await rpc!.send({ type: "prompt", message: "/ralph-stop" })).success; } catch { return false; } })();
			stopResults.set(token, pending);
		}
		const success = await pending;
		if (!success) stopResults.delete(token);
		else if (id) { const ids = acceptedStops.get(token) ?? new Set<string>(); ids.add(id); acceptedStops.set(token, ids); }
		intervention(success, success ? undefined : "pi-rejected");
		ack(success ? (endedTokens.has(token) ? "completed" : "accepted") : "rejected", success ? undefined : "pi-rejected", duplicate && success);
	}
	function receiveControl(line: string): void {
		if (!line) return;
		if (line === "/ralph-stop") { void control(null).catch((error) => log(`control: ${String(error)}`)); return; }
		const envelope = parseEnvelope(line);
		if (!envelope) {
			log("FIFO: rejected invalid command");
			try {
				const value: unknown = JSON.parse(line);
				if (object(value) && typeof value.id === "string" && value.id.length <= 64) events?.publish({ type: "ack", id: value.id, op: value.op === "steer" || value.op === "go" ? value.op : "stop", phase: "rejected", reason: "bad-envelope" });
			} catch { /* Plain text is never forwarded to pi. */ }
			return;
		}
		void control(envelope).catch((error) => log(`control: ${String(error)}`));
	}
	let exit: DriverExit | null = null;
	try {
		const fifoPath = ensureFifo(root);
		const paths = socketPaths(root, runtime.tmpDir);
		events = new EventServer(paths.eventSocket, () => ({ v: 1, type: "hello", launchId: spec.launchId, pid: process.pid, nextSeq: events!.nextSeq, lastPiAt: monitor.lastPiAt, loop, tools: monitor.tools, totals: monitor.totals, counters: monitor.counters, state }), () => { monitor.counters.subscriberDrops++; log("events: dropped subscriber over 1 MB"); }, now);
		facts = new LineServer(paths.factSocket, receiveFact, () => { monitor.counters.badFacts++; });
		await events.listen(); await facts.listen();
		fifo = readFifo(fifoPath, receiveControl, () => log("FIFO: rejected oversized command"));
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
				launchPending = true;
				monitor.onErrorNotify = (message) => { if (launchPending) finish("launch-rejected", null, message); };
				const response = await Promise.race([rpc.send({ type: "prompt", message: `/ralph-loop ${task} --max-iterations=${spec.mission.run.maxIterations}` }).catch(() => null), terminal.then(() => null)]);
				if (!finished && !response?.success) finish("launch-rejected", null, response?.error ?? "Pi rejected launch");
				else if (!finished && launchPending) {
					const limit = runtime.launchTimeoutMs ?? LAUNCH_CONFIRM_TIMEOUT_MS;
					launchTimer = setTimeout(() => { if (launchPending) finish("launch-rejected", null, `No iteration-start fact within ${limit} ms`); }, limit);
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
			flushUsage(); driverFact("exit", exit?.reason, exit?.code);
			events?.publish({ type: "lifecycle", state: "closed", code, ...(exit?.detail ? { detail: exit.detail } : {}) });
		}
		fifo?.destroy();
		await facts?.close(); await events?.close();
		if (metadataWritten && existsSync(join(root, ".ralph/driver.json"))) unlinkSync(join(root, ".ralph/driver.json"));
		releaseLock();
	}
	return exit!;
}
