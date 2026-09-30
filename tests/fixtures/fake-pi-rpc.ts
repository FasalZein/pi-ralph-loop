import { appendFileSync } from "node:fs";
import { connect } from "node:net";

type Step =
	| { op: "emit"; record: unknown }
	| { op: "raw"; text: string }
	| { op: "fact"; envelope: unknown }
	| { op: "sleep"; ms: number }
	| { op: "flood"; n: number }
	| { op: "exit"; code: number };
type Scenario = { ready?: "silent" | "exit"; readyDelay?: number; promptSuccess?: boolean; steerSuccess?: boolean; responseDelay?: number; steps?: Step[]; stopSteps?: Step[]; ignoreEOF?: boolean };
const scenario: Scenario = JSON.parse(process.env.FAKE_PI_SCENARIO ?? "{}");
const log = (record: unknown) => {
	if (process.env.FAKE_PI_STDIN_LOG) appendFileSync(process.env.FAKE_PI_STDIN_LOG, `${JSON.stringify(record)}\n`);
};
log({ argv: process.argv.slice(2), env: { RALPH_WATCH_FACT_SOCKET: process.env.RALPH_WATCH_FACT_SOCKET, RALPH_WATCH_LAUNCH_ID: process.env.RALPH_WATCH_LAUNCH_ID, RALPH_BLOCKED_TOOLS: process.env.RALPH_BLOCKED_TOOLS }, pid: process.pid });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (record: unknown) => process.stdout.write(`${JSON.stringify(record)}\n`);
async function steps(items: Step[]): Promise<void> {
	for (const step of items) {
		switch (step.op) {
			case "emit": emit(step.record); break;
			case "raw": process.stdout.write(step.text); break;
			case "sleep": await sleep(step.ms); break;
			case "exit": process.exit(step.code); break;
			case "fact": await new Promise<void>((resolve, reject) => {
				const socket = connect(process.env.RALPH_WATCH_FACT_SOCKET!);
				socket.on("error", reject);
				socket.on("connect", () => socket.end(`${JSON.stringify(step.envelope)}\n`));
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
	} else await sleep(scenario.responseDelay ?? 0);
	const success = command.type === "steer" ? scenario.steerSuccess !== false : scenario.promptSuccess !== false;
	emit({ type: "response", id: command.id, command: command.type, success, data: { disposition: "handled" }, error: success ? undefined : "fixture rejection" });
	if (command.type === "prompt") await steps(command.message === "/ralph-stop" ? scenario.stopSteps ?? [] : scenario.steps ?? []);
}
process.stdin.on("end", () => {
	log({ eof: true });
	if (!scenario.ignoreEOF) process.exit(0);
	else setInterval(() => {}, 1000);
});
