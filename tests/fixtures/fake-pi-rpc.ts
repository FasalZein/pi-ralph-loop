import { appendFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { writeState } from "../../src/state.ts";

type Step =
	| { op: "emit"; record: unknown }
	| { op: "raw"; text: string }
	| { op: "fact"; envelope: unknown }
	| { op: "sleep"; ms: number }
	| { op: "flood"; n: number }
	| { op: "exit"; code: number }
	| { op: "big"; bytes: number }
	// Scratch loop state in the pi cwd (a temp root). `partial` writes an incomplete document.
	// `foreign`: a run owned by another live process (this fake's parent) and session.
	| { op: "state"; running: boolean; iteration?: number; maxIterations?: number; stopRequested?: boolean; stopReason?: string | null; partial?: boolean; foreign?: boolean };
type Scenario = { ready?: "silent" | "exit"; readyDelay?: number; promptSuccess?: boolean; steerSuccess?: boolean; responseDelay?: number; silentPrompt?: boolean; preSteps?: Step[]; steps?: Step[]; stopSteps?: Step[]; ignoreEOF?: boolean };
const TOKEN = "token";
const STARTED_AT = "2026-09-30T00:00:00.000Z";
const scenario: Scenario = JSON.parse(process.env.FAKE_PI_SCENARIO ?? "{}");
const log = (record: unknown) => {
	if (process.env.FAKE_PI_STDIN_LOG) appendFileSync(process.env.FAKE_PI_STDIN_LOG, `${JSON.stringify(record)}\n`);
};
const herdr = Object.keys(process.env).filter((name) => name.startsWith("HERDR_"));
log({ argv: process.argv.slice(2), cwd: process.cwd(), env: { RALPH_WATCH_FACT_SOCKET: process.env.RALPH_WATCH_FACT_SOCKET, RALPH_WATCH_LAUNCH_ID: process.env.RALPH_WATCH_LAUNCH_ID, RALPH_BLOCKED_TOOLS: process.env.RALPH_BLOCKED_TOOLS, PI_SUBAGENT_MUX: process.env.PI_SUBAGENT_MUX, herdr } , pid: process.pid });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (record: unknown) => process.stdout.write(`${JSON.stringify(record)}\n`);
async function steps(items: Step[]): Promise<void> {
	for (const step of items) {
		switch (step.op) {
			case "emit": emit(step.record); break;
			case "raw": process.stdout.write(step.text); break;
			case "sleep": await sleep(step.ms); break;
			case "exit": process.exit(step.code); break;
			case "state":
				if (step.partial) writeFileSync(join(process.cwd(), ".ralph/loop.md"), "---\nrunning: false\niteration: 1\n");
				else writeState(process.cwd(), { running: step.running, iteration: step.iteration ?? 1, max_iterations: step.maxIterations ?? 3, started_at: STARTED_AT, completed_at: step.running ? null : STARTED_AT, stop_reason: (step.stopReason ?? (step.running ? null : "manual_stop")) as never, session_id: step.foreign ? "foreign" : "fake-session", last_session_file: null, owner_pid: step.running ? (step.foreign ? process.ppid : process.pid) : null, owner_heartbeat_at: step.running ? new Date().toISOString() : null, error_count: 0, transitioning: false, cancel_requested: false, stop_requested: step.stopRequested ?? false, bundle_mode: false, loop_token: step.foreign ? "foreign-token" : TOKEN, model_provider: null, model_id: null, thinking_level: null, bundle_snapshot_hash: null, items_snapshot_hash: null, progress_size: null, progress_hash: null, progress_snapshot: null, source_doc_hashes: null, bundle_items_snapshot: null, git_head: null, bundle_rejection_count: 0, provider_recovery_fresh_fallback_used: false, limit_reminders: null }, "Do the task.");
				break;
			case "big": {
				// One oversized record (like a long agent_end), written in pipe-sized chunks.
				const record = Buffer.from(`{"type":"agent_end","pad":"${"x".repeat(step.bytes)}"}\n`);
				for (let offset = 0; offset < record.length; offset += 65_536) {
					if (!process.stdout.write(record.subarray(offset, offset + 65_536))) await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
				}
				break;
			}
			case "fact": await new Promise<void>((resolve, reject) => {
				const socket = connect(process.env.RALPH_WATCH_FACT_SOCKET!);
				socket.on("error", reject);
				// "$env" stands for the launch identity the driver passed to pi.
				socket.on("connect", () => socket.end(`${JSON.stringify(step.envelope).replaceAll('"launchId":"$env"', JSON.stringify({ launchId: process.env.RALPH_WATCH_LAUNCH_ID }).slice(1, -1))}\n`));
				socket.on("close", () => resolve());
			}); break;
			case "flood":
				for (let i = 0; i < step.n; i++) {
					if (!emit({ type: "tool_execution_start", toolCallId: `flood-${i}`, toolName: "test", args: { text: "x".repeat(120) } })) await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
				}
				break;
		}
	}
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	let newline: number;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
		const command = JSON.parse(line);
		log(command);
		void respond(command);
	}
});
async function respond(command: { type: string; id: string; message?: string }): Promise<void> {
	if (command.type === "extension_ui_response") return;
	if (command.type === "get_state") {
		if (scenario.ready === "exit") process.exit(7);
		if (scenario.ready === "silent") return;
		await sleep(scenario.readyDelay ?? 0);
	} else {
		const launch = command.type === "prompt" && command.message !== "/ralph-stop";
		if (launch) await steps(scenario.preSteps ?? []);
		if (launch && scenario.silentPrompt) { await steps(scenario.steps ?? []); return; }
		await sleep(scenario.responseDelay ?? 0);
	}
	const success = command.type === "steer" ? scenario.steerSuccess !== false : scenario.promptSuccess !== false;
	emit({ type: "response", id: command.id, command: command.type, success, data: { disposition: "handled" }, error: success ? undefined : "fixture rejection" });
	if (command.type === "prompt") await steps(command.message === "/ralph-stop" ? scenario.stopSteps ?? [] : scenario.steps ?? []);
}
process.stdin.on("end", () => {
	log({ eof: true });
	if (!scenario.ignoreEOF) process.exit(0);
	else setInterval(() => {}, 1000);
});
