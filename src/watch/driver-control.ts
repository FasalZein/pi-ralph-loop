import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { FactTracker } from "./driver-facts.js";
import { object, type JournalWriter } from "./journal.js";
import type { PiRpc, RpcMonitor } from "./rpc.js";
import { ControlError, parseEnvelope, type Broadcast, type Envelope } from "./transport.js";

export type ControlHooks = {
	readonly root: string;
	readonly launchId: string;
	readonly tracker: FactTracker;
	readonly monitor: RpcMonitor;
	readonly rpc: () => PiRpc | null;
	readonly journal: () => JournalWriter | null;
	readonly base: () => { v: 1; t: string; r: string };
	readonly publish: (frame: Broadcast) => void;
	readonly log: (line: string) => void;
	readonly finished: () => boolean;
	readonly launched: () => boolean;
	/** Release the launch gate; returns false when this driver has no FIFO gate. */
	readonly releaseGate: () => boolean;
	/** Stop before any loop exists; returns a reason when the driver ends the launch itself. */
	readonly stopBeforeLaunch: () => string | null;
};

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

/** FIFO control parsing and dispatch. Stops are idempotent per loop token. */
export class ControlHandler {
	private released = false;
	private readonly acceptedStops = new Map<string, Set<string>>();
	private readonly stopResults = new Map<string, Promise<boolean>>();
	constructor(private readonly hooks: ControlHooks) {}
	/** Complete every accepted stop for a loop that just ended. */
	loopEnded(token: string): void {
		for (const id of this.acceptedStops.get(token) ?? []) this.hooks.publish({ type: "ack", id, op: "stop", phase: "completed" });
	}
	receive(line: string): void {
		if (!line) return;
		if (line === "/ralph-stop") { void this.control(null).catch((error) => this.hooks.log(`control: ${String(error)}`)); return; }
		const envelope = parseEnvelope(line);
		if (!envelope) {
			this.hooks.log("FIFO: rejected invalid command");
			try {
				const value: unknown = JSON.parse(line);
				if (object(value) && typeof value.id === "string" && value.id.length <= 64) this.hooks.publish({ type: "ack", id: value.id, op: value.op === "steer" || value.op === "go" ? value.op : "stop", phase: "rejected", reason: "bad-envelope" });
			} catch { /* Plain text is never forwarded to pi. */ }
			return;
		}
		void this.control(envelope).catch((error) => this.hooks.log(`control: ${String(error)}`));
	}
	private async control(envelope: Envelope | null): Promise<void> {
		const { hooks } = this;
		const { tracker } = hooks;
		const op = envelope?.op ?? "stop";
		const id = envelope?.id ?? null;
		const token = tracker.loop?.token ?? "pre-loop";
		const ack = (phase: "accepted" | "completed" | "rejected", reason?: string, duplicate?: boolean) => { if (id) hooks.publish({ type: "ack", id, op, phase, ...(reason ? { reason } : {}), ...(duplicate ? { duplicate } : {}) }); };
		const intervention = (ok: boolean, why?: string, txt?: string) => { if (op !== "go") hooks.journal()?.append({ ...hooks.base(), k: "x", op, id, ok: ok ? 1 : 0, ...(why ? { why: why.slice(0, 100) } : {}), ...(txt !== undefined ? { txt } : {}) }); };
		if (envelope && (envelope.launch !== hooks.launchId || (envelope.token !== null && envelope.token !== tracker.loop?.token))) { ack("rejected", "wrong-run"); return; }
		if (op === "go") {
			if (!hooks.releaseGate()) { ack("rejected", "no-fifo-gate"); return; }
			ack("accepted", undefined, this.released); this.released = true; return;
		}
		const rpc = hooks.rpc();
		if (op === "steer" && envelope?.op === "steer") {
			let steer: { path: string; text: string };
			try { steer = readSteer(hooks.root, envelope.textPath); } catch (error) { ack("rejected", String(error)); intervention(false, "invalid-steer-path"); return; }
			try {
				if (!hooks.launched() || hooks.finished() || !rpc) { intervention(false, "not-launched", steer.text); ack("rejected", "not-launched"); return; }
				// pi queues a steer even while idle; it would reach a later iteration or be lost.
				if (hooks.monitor.settled) { intervention(false, "not-streaming", steer.text); ack("rejected", "not-streaming"); return; }
				const response = await rpc.send({ type: "steer", message: steer.text });
				intervention(response.success, response.error ?? undefined, steer.text);
				ack(response.success ? "accepted" : "rejected", response.error ?? undefined);
			} catch (error) { intervention(false, String(error), steer.text); ack("rejected", String(error)); }
			finally { try { unlinkSync(steer.path); } catch (error) { hooks.log(`steer cleanup: ${String(error)}`); } }
			return;
		}
		if (!hooks.launched()) {
			const reason = hooks.stopBeforeLaunch();
			if (reason) { intervention(true, reason); ack("completed", reason); return; }
		}
		if (tracker.endedTokens.has(token)) { intervention(true, "already-ended"); ack("completed"); return; }
		const duplicate = this.stopResults.has(token);
		let pending = this.stopResults.get(token);
		if (!pending) {
			pending = (async () => { try { return (await rpc!.send({ type: "prompt", message: "/ralph-stop" })).success; } catch { return false; } })();
			this.stopResults.set(token, pending);
		}
		const success = await pending;
		if (!success) this.stopResults.delete(token);
		else if (id) { const ids = this.acceptedStops.get(token) ?? new Set<string>(); ids.add(id); this.acceptedStops.set(token, ids); }
		intervention(success, success ? undefined : "pi-rejected");
		ack(success ? (tracker.endedTokens.has(token) ? "completed" : "accepted") : "rejected", success ? undefined : "pi-rejected", duplicate && success);
	}
}
