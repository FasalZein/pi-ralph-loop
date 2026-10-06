import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { object } from "./journal.js";
import { MESSAGE_CHARS, type DriverEvent, type IterationTotals, type ToolEntry } from "./types.js";

export const TOOL_BUFFER_CALLS = 200;
export const PI_READY_TIMEOUT_MS = 120_000;
export const PI_SHUTDOWN_GRACE_MS = 10_000;
export type RpcResponse = { readonly success: boolean; readonly error: string | null };
export type RpcCommand = { readonly type: "get_state" } | { readonly type: "prompt" | "steer"; readonly message: string };
export const emptyTotals = (): IterationTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0, dialogsCancelled: 0, refusals: 0 });
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const text = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;

/** In-memory summaries only. Raw pi records never leave the stdout handler. */
export class RpcMonitor {
	tools: ToolEntry[] = [];
	totals = emptyTotals();
	lastPiAt: string | null = null;
	settled = true;
	counters = { dialogsCancelled: 0, refusals: 0, badRecords: 0, badFacts: 0, subscriberDrops: 0 };
	/** Called for an error notify; before launch confirmation it means the command refused. */
	onErrorNotify: (message: string) => void = () => {};
	private lastActivity = -Infinity;
	constructor(private readonly emit: (event: DriverEvent) => void, private readonly now: () => Date = () => new Date()) {}
	resetIteration(): void { this.tools = []; this.totals = emptyTotals(); }
	record(record: Record<string, unknown>, reply: (record: Record<string, unknown>) => void): void {
		const date = this.now();
		const at = date.toISOString();
		this.lastPiAt = at;
		if (date.getTime() - this.lastActivity >= 1000) { this.lastActivity = date.getTime(); this.emit({ kind: "activity" }); }
		if (record.type === "agent_start") this.settled = false;
		if (record.type === "agent_settled") this.settled = true;
		if (record.type === "extension_ui_request" && typeof record.id === "string" && ["select", "confirm", "input", "editor"].includes(text(record.method))) {
			reply({ type: "extension_ui_response", id: record.id, cancelled: true });
			this.counters.dialogsCancelled++;
			this.totals = { ...this.totals, dialogsCancelled: this.totals.dialogsCancelled + 1 };
			this.emit({ kind: "dialog-cancelled", method: text(record.method), title: typeof record.title === "string" ? record.title.slice(0, 100) : null });
		}
		if (record.type === "extension_ui_request" && record.method === "notify" && record.notifyType === "error") this.onErrorNotify(text(record.message, "pi reported an error").slice(0, 200));
		if (record.type === "tool_execution_start" && typeof record.toolCallId === "string") {
			const label = object(record.args) ? JSON.stringify(record.args).slice(0, 120) : "";
			const tool: ToolEntry = { id: record.toolCallId, name: text(record.toolName), label, startedAt: at, endedAt: null };
			this.tools.push(tool);
			if (this.tools.length > TOOL_BUFFER_CALLS) this.tools.shift();
			this.emit({ kind: "tool-start", tool });
		}
		if (record.type === "tool_execution_end" && typeof record.toolCallId === "string") {
			const index = this.tools.findIndex((tool) => tool.id === record.toolCallId);
			const start = this.tools[index];
			const tool: ToolEntry = { id: record.toolCallId, name: start?.name ?? text(record.toolName), label: start?.label ?? "", startedAt: start?.startedAt ?? null, endedAt: at, ms: start?.startedAt ? Math.max(0, date.getTime() - Date.parse(start.startedAt)) : null, error: record.isError === true };
			if (index >= 0) this.tools[index] = tool;
			else { this.tools.push(tool); if (this.tools.length > TOOL_BUFFER_CALLS) this.tools.shift(); }
			this.emit({ kind: "tool-end", tool });
			const result = object(record.result) ? record.result : {};
			const content = Array.isArray(result.content) ? result.content : [];
			const refusal = content.find((item: unknown) => object(item) && typeof item.text === "string" && /Dangerous command requires confirmation|Blocked by permission|is illegal to use during Ralph loops/.test(item.text));
			if (record.isError === true && object(refusal) && typeof refusal.text === "string") {
				this.counters.refusals++;
				this.totals = { ...this.totals, refusals: this.totals.refusals + 1 };
				this.emit({ kind: "refusal", tool: tool.name, text: refusal.text.slice(0, 200) });
			}
		}
		if (record.type === "message_end" && object(record.message) && record.message.role === "assistant") {
			const message = record.message;
			const content = Array.isArray(message.content) ? message.content : [];
			const assistantText = Array.from(content.flatMap((part: unknown) => object(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n")).slice(0, MESSAGE_CHARS).join("");
			if (assistantText) this.emit({ kind: "message", text: assistantText });
			const raw = object(message.usage) ? message.usage : {};
			const usage = { input: number(raw.input), output: number(raw.output), cacheRead: number(raw.cacheRead), cacheWrite: number(raw.cacheWrite) };
			const costUsd = object(raw.cost) ? number(raw.cost.total) : 0;
			this.totals = { ...this.totals, input: this.totals.input + usage.input, output: this.totals.output + usage.output, cacheRead: this.totals.cacheRead + usage.cacheRead, cacheWrite: this.totals.cacheWrite + usage.cacheWrite, costUsd: this.totals.costUsd + costUsd, messages: this.totals.messages + 1 };
			this.emit({ kind: "assistant-end", usage, costUsd, stopReason: typeof message.stopReason === "string" ? message.stopReason : null, model: typeof message.model === "string" ? message.model : null });
		}
	}
}

export class PiRpc {
	readonly child: ChildProcessWithoutNullStreams;
	readonly exited: Promise<number | null>;
	private dead = false;
	private serial = 0;
	private readonly pending = new Map<string, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void; onResponse?: (value: RpcResponse) => void }>();
	private readonly queue: string[] = [];
	private draining = false;
	private chunks: Buffer[] = [];
	constructor(file: string, args: readonly string[], options: SpawnOptionsWithoutStdio, private readonly monitor: RpcMonitor, private readonly log: (line: string) => void = console.error, private readonly onRecord: () => void = () => {}) {
		this.child = spawn(file, [...args], { ...options, stdio: "pipe" });
		this.exited = new Promise((resolve) => {
			const finish = (code: number | null) => {
				if (this.dead) return;
				this.dead = true;
				for (const request of this.pending.values()) request.reject(new Error("pi-exited"));
				this.pending.clear(); this.queue.length = 0;
				resolve(code);
			};
			this.child.on("exit", finish);
			this.child.on("error", (error) => { this.log(`pi: ${error.message}`); finish(null); });
		});
		this.child.stdin.on("error", (error) => {
			for (const request of this.pending.values()) request.reject(error);
			this.pending.clear(); this.queue.length = 0;
		});
		this.child.stdin.on("drain", () => { this.draining = false; this.pump(); });
		// Drain stderr without persisting model output or mixing it into frames.
		this.child.stderr.on("data", () => {});
		this.child.stdout.on("data", (chunk: Buffer) => {
			// Linear framing: scan only the new chunk for LF and join once per record.
			let start = 0;
			let newline: number;
			while ((newline = chunk.indexOf(10, start)) >= 0) {
				this.chunks.push(chunk.subarray(start, newline));
				const bytes = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
				this.chunks = [];
				start = newline + 1;
				const line = bytes.toString("utf8").replace(/\r$/, "");
				let record: unknown;
				try { record = JSON.parse(line); } catch { this.monitor.counters.badRecords++; continue; }
				if (!object(record) || typeof record.type !== "string") { this.monitor.counters.badRecords++; continue; }
				this.monitor.record(record, (reply) => this.write(reply));
				if (record.type === "response") {
					if (typeof record.id !== "string" || typeof record.success !== "boolean") { this.monitor.counters.badRecords++; this.log("pi: uncorrelated or invalid response"); }
					else {
						const pending = this.pending.get(record.id);
						if (pending) {
							const response = { success: record.success, error: typeof record.error === "string" ? record.error : null };
							this.pending.delete(record.id); pending.onResponse?.(response); pending.resolve(response);
						}
					}
				}
				this.onRecord();
			}
			if (start < chunk.length) this.chunks.push(chunk.subarray(start));
		});
	}
	private write(record: Record<string, unknown>): void {
		if (this.dead || this.child.stdin.writableEnded) return;
		this.queue.push(`${JSON.stringify(record)}\n`);
		this.pump();
	}
	private pump(): void {
		while (!this.draining && this.queue.length && !this.dead && !this.child.stdin.writableEnded) {
			this.draining = !this.child.stdin.write(this.queue.shift()!);
		}
	}
	/**
	 * `onResponse` runs synchronously at the response record, before any later
	 * record in the same stdout chunk; a promise continuation would run after them.
	 */
	send(command: RpcCommand, onResponse?: (response: RpcResponse) => void): Promise<RpcResponse> {
		if (this.dead || this.child.stdin.writableEnded) return Promise.reject(new Error("pi-exited"));
		const id = `d-${++this.serial}`;
		return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, onResponse }); this.write({ ...command, id }); });
	}
	async close(graceMs = PI_SHUTDOWN_GRACE_MS): Promise<number | null> {
		this.child.stdin.end();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const grace = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), graceMs); });
		const first = await Promise.race([this.exited, grace]);
		clearTimeout(timer);
		if (first !== "timeout") return first;
		this.child.kill("SIGTERM");
		// A child that ignores SIGTERM must not keep the driver alive forever.
		const kill = setTimeout(() => this.child.kill("SIGKILL"), graceMs);
		try { return await this.exited; } finally { clearTimeout(kill); }
	}
}
