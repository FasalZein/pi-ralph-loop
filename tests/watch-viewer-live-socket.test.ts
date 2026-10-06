import { fork } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runDriver, immediateGate } from "../src/watch/driver.ts";
import { readMetadata } from "../src/watch/transport.ts";
import { loadMission } from "../src/watch/config.ts";
import { openLoop } from "../src/watch/loop-state.ts";
import { connectEvents } from "../src/watch/events.ts";
import { runViewer } from "../src/watch/viewer.ts";
import { Fixture } from "./fixtures/loop-state.ts";
import { ReplayTerminal } from "./fixtures/replay-terminal.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi-rpc.ts", import.meta.url));
const waitFor = async (check: () => boolean) => {
	const end = Date.now() + 5_000;
	while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 10)); }
};

test("real driver: closing and reattaching viewers preserves pi and replays the current tool buffer", async (t) => {
	const f = new Fixture([], { plain: true });
	const abort = new AbortController();
	const driver = runDriver({ mission: await loadMission(f.root), launchId: "live-socket", gate: immediateGate }, {
		piCommand: { file: process.execPath, args: ["--import", import.meta.resolve("tsx"), fixture] },
		env: { ...process.env, FAKE_PI_STDIN_LOG: `${f.root}/pi.log`, FAKE_PI_SCENARIO: JSON.stringify({ steps: [
			{ op: "state", running: true },
			{ op: "fact", envelope: { version: 1, id: "start", sequence: 1, fact: { kind: "iteration-start", phase: "initialized", iteration: 1, at: "2026-09-30T00:00:00.000Z", run: { launchId: "$env", loopToken: "token", startedAt: "2026-09-30T00:00:00.000Z" } } } },
			{ op: "emit", record: { type: "tool_execution_start", toolCallId: "buffer", toolName: "bash", args: { command: "echo replay-me" } } },
			{ op: "emit", record: { type: "tool_execution_end", toolCallId: "buffer", isError: false } },
		] }) },
		signal: abort.signal, shutdownGraceMs: 100, log: () => {},
	});
	t.after(async () => { abort.abort(); await driver; f.close(); });
	await waitFor(() => existsSync(`${f.root}/.ralph/driver.json`) && existsSync(`${f.root}/pi.log`) && existsSync(`${f.root}/.ralph/loop.md`));
	const piPid: unknown = JSON.parse(readFileSync(`${f.root}/pi.log`, "utf8").split("\n")[0]).pid;
	assert.equal(typeof piPid, "number");
	if (typeof piPid !== "number") throw new Error("fixture pid missing");
	const sessions: { terminal: ReplayTerminal; done: Promise<void> }[] = [];
	t.after(async () => {
		for (const s of sessions) if (!s.terminal.stopped) { s.terminal.send("\x03"); s.terminal.send("\x03"); await s.done; }
	});
	// A separate event observer represents the enforcer's subscription; viewer quit must not close it.
	const observerAbort = new AbortController();
	let observerFrames = 0;
	let observerClosed = false;
	const observer = (async () => { for await (const _ of connectEvents({ root: f.root }, observerAbort.signal)) observerFrames++; })().finally(() => { observerClosed = true; });
	t.after(async () => { observerAbort.abort(); await observer; });
	const crashed = fork(fileURLToPath(new URL("./fixtures/viewer-process.ts", import.meta.url)), [f.root], { execArgv: ["--import", import.meta.resolve("tsx")], stdio: ["ignore", "ignore", "pipe", "ipc"] });
	const crashedExit = new Promise<void>((resolve) => crashed.once("exit", () => resolve()));
	t.after(async () => { if (crashed.exitCode === null && crashed.signalCode === null) crashed.kill("SIGKILL"); await crashedExit; });
	let crashedScreen = "";
	crashed.on("message", (screen: unknown) => { if (typeof screen === "string") crashedScreen = screen; });
	await waitFor(() => crashedScreen.includes("replay-me"));
	crashed.kill("SIGKILL"); await crashedExit;
	assert.equal(crashed.signalCode, "SIGKILL");
	process.kill(piPid, 0);
	assert.equal(observerClosed, false);
	for (let i = 0; i < 2; i++) {
		const terminal = new ReplayTerminal(120, 30);
		const done = runViewer({ roots: [f.root] }, {
			terminal, now: Date.now, setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>), openLoop,
		});
		sessions.push({ terminal, done });
		await waitFor(() => terminal.text().includes("replay-me"));
		assert.match(terminal.text(), /Execute/);
		terminal.send("a");
		await waitFor(() => terminal.text().includes("Activity · all"));
		assert.match(terminal.text(), /replay-me/);
		terminal.send("Q"); terminal.send("y");
		await done;
		// Check the real child, not just metadata freshness.
		process.kill(piPid, 0);
		process.kill(readMetadata(f.root).pid, 0);
		assert.equal(observerClosed, false);
		assert.ok(observerFrames > 0);
	}
	observerAbort.abort(); await observer;
	abort.abort(); await driver;
	assert.throws(() => process.kill(piPid, 0), { code: "ESRCH" });
	assert.equal(existsSync(`${f.root}/.ralph/driver.json`), false);
});
