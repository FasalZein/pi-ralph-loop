import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execute } from "../src/watch/commands.ts";
import { tmuxHost } from "../src/watch/hosts/tmux.ts";
import { readStateDocument } from "../src/state.ts";

const roleFixture = fileURLToPath(new URL("./fixtures/driver-role.ts", import.meta.url));
const available = spawnSync("tmux", ["-V"]).status === 0;
const fact = (sequence: number, detail: Record<string, unknown>) => ({ op: "fact", envelope: { version: 1, id: String(sequence), sequence, fact: { run: { launchId: "$env", loopToken: "token", startedAt: "2026-09-30T00:00:00.000Z" }, iteration: 1, at: "2026-09-30T00:00:00.000Z", ...detail } } });

for (const kind of ["plain", "bundle"] as const) test(`scratch tmux launches fake-pi ${kind} task and stop closes only exact idle session`, { skip: available ? false : "tmux unavailable" }, async (t) => {
	// Isolated scratch server only; never the default server.
	const server = `rw-t9-${process.pid}-${randomUUID().slice(0, 8)}`;
	const tmux = (...args: string[]) => spawnSync("tmux", ["-L", server, ...args], { encoding: "utf8" });
	const root = realpathSync(mkdtempSync(join(tmpdir(), "rw-t9-tmux-")));
	const piLog = join(root, "pi.log");
	t.after(async () => {
		// On failure a managed driver keeps its pi alive; end the fake pi so the driver exits and cleans up.
		// Only while this root's driver is still live, so a reused PID is never signalled.
		const pid = existsSync(piLog) && existsSync(join(root, ".ralph/driver.json")) ? JSON.parse(readFileSync(piLog, "utf8").split("\n")[0]).pid : null;
		if (typeof pid === "number") try { process.kill(pid, "SIGTERM"); await new Promise((r) => setTimeout(r, 500)); } catch { /* already gone */ }
		const socket = tmux("display-message", "-p", "#{socket_path}").stdout.trim();
		tmux("kill-server");
		if (socket.includes(server)) rmSync(socket, { force: true });
		rmSync(root, { recursive: true, force: true });
	});
	assert.equal(tmux("new-session", "-d", "-s", "sentinel", "sh", "-c", "exec tail -f /dev/null").status, 0);
	for (const name of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_CUSTOM_X"]) tmux("set-environment", "-g", name, "inherited");
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"], { cwd: root });
	const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	mkdirSync(join(root, ".ralph"));
	if (kind === "bundle") {
		for (const name of ["plan", "prompt", "progress"]) writeFileSync(join(root, `.ralph/${name}.md`), name);
		writeFileSync(join(root, ".ralph/items.json"), JSON.stringify({ version: 1, items: [{ id: "first", title: "First", category: "feature", description: "Do first", steps: ["verify"], passes: false, regression_notes: "" }] }));
	}
	writeFileSync(join(root, ".ralph/mission.json"), JSON.stringify({ version: 1, task: kind === "bundle" ? { kind: "bundle" } : { kind: "plain", prompt: "Do it; echo $HOME 'quoted' && true" }, run: { model: "test-model", thinking: "high", maxIterations: 3, budgetAuthority: "Test" }, git: { baseCommit: sha }, rules: {}, host: { prefer: ["tmux"] } }));
	const scenario = join(root, "scenario.json");
	writeFileSync(scenario, JSON.stringify({
		steps: [{ op: "state", running: true }, fact(1, { kind: "iteration-start", phase: "initialized" }), { op: "emit", record: { type: "agent_start" } }],
		stopSteps: [{ op: "state", running: true, stopRequested: true }, { op: "sleep", ms: 600 }, { op: "state", running: true, partial: true }, { op: "sleep", ms: 600 }, { op: "state", running: false }, fact(2, { kind: "loop-ended", reason: "manual_stop" }), { op: "emit", record: { type: "agent_settled" } }],
	}));
	const env = { ...process.env, HERDR_CALLER: "caller" };
	const host = tmuxHost({ server: ["-L", server], env });
	const lines: string[] = [];
	const runtime = { host, env, err: (line: string) => lines.push(line), pollMs: 100, driverArgv: (manifest: string) => [process.execPath, "--import", import.meta.resolve("tsx"), roleFixture, manifest, scenario, piLog] };

	const launched = await execute({ kind: "launch", root, mode: "fresh" }, runtime);
	assert.ok(launched.ok, launched.ok ? "" : launched.error);
	const handle = launched.handle!;
	assert.equal(handle.socket, tmux("display-message", "-p", "#{socket_path}").stdout.trim());
	const records = readFileSync(piLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(records[0].argv, ["--mode", "rpc", "--model", "test-model", "--thinking", "high"]);
	assert.equal(records[0].cwd, root);
	assert.deepEqual(records[0].env.herdr, [], "caller and server HERDR variables are cleared");
	assert.equal(records[0].env.PI_SUBAGENT_MUX, "tmux");
	assert.equal(records[0].env.RALPH_WATCH_LAUNCH_ID, handle.launchId);
	assert.equal(records.find((r) => r.type === "prompt")?.message, kind === "bundle" ? '/ralph-loop "@.ralph/prompt.md" --max-iterations=3' : "/ralph-loop Do it; echo $HOME 'quoted' && true --max-iterations=3");
	assert.equal(tmux("show-options", "-w", "-t", handle.windowId, "-v", "remain-on-exit").stdout.trim(), "on");
	const document = readStateDocument(root);
	assert.ok(document.status === "valid" && document.state.running);

	// While stop waits, the session must exist whenever the state is not a valid running=false.
	let closedEarly = false;
	let stopping = true;
	const sampler = (async () => {
		while (stopping) {
			const state = readStateDocument(root);
			const alive = tmux("has-session", "-t", handle.sessionId).status === 0;
			if (!alive && !(state.status === "valid" && !state.state.running)) closedEarly = true;
			await new Promise((r) => setTimeout(r, 50));
		}
	})();
	const stopped = await execute({ kind: "stop", root, timeoutMs: null }, runtime);
	stopping = false; await sampler;
	assert.ok(stopped.ok, stopped.ok ? "" : stopped.error);
	assert.equal(closedEarly, false);
	assert.ok(records.length > 0 && readFileSync(piLog, "utf8").includes('"/ralph-stop"'));
	assert.ok(lines.some((line) => /running=true, stop_requested=true/.test(line)), lines.join("\n"));
	assert.ok(lines.some((line) => /state unavailable/.test(line)), lines.join("\n"));
	assert.notEqual(tmux("has-session", "-t", handle.sessionId).status, 0, "exact launched session is closed");
	assert.equal(tmux("has-session", "-t", "sentinel").status, 0, "unrelated session survives");
	assert.equal(existsSync(join(root, ".ralph/watch-host.json")), false);
	assert.equal(existsSync(join(root, ".ralph/driver.json")), false);
});

/** Recording tmux: scripted answers, no server. */
function recording(answers: Record<string, string> = {}) {
	const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
	const exec = async (args: readonly string[], env: NodeJS.ProcessEnv) => {
		calls.push({ args, env });
		const command = args.find((arg) => !arg.startsWith("-") && !arg.startsWith("/")) ?? "";
		if (command === "new-session") return { code: 0, stdout: "$3\t@4\t%5\t/tmp/tmux-1/default\n", stderr: "" };
		return { code: 0, stdout: answers[command] ?? "", stderr: "" };
	};
	return { exec, calls };
}

test("role argv preserves shell punctuation literally and tmux role clears caller and server HERDR variables", async () => {
	const { exec, calls } = recording({ "show-environment": "HERDR_SERVER=1\n-HERDR_REMOVED\nPATH=/bin\n" });
	const host = tmuxHost({ exec, env: { PATH: "/bin", HERDR_CALLER: "1" } });
	const handle = await host.open("/work/my root", "launch-1234", { title: "loop", argv: ["node", "x.mjs", "a; rm -rf $HOME 'q' && `id`"], env: { PI_SUBAGENT_MUX: "tmux" } });
	assert.deepEqual([handle.sessionId, handle.windowId, handle.paneId, handle.socket], ["$3", "@4", "%5", "/tmp/tmux-1/default"]);
	assert.ok(calls.every((call) => !Object.keys(call.env).some((name) => name.startsWith("HERDR_"))), "tmux client never passes HERDR variables");
	const respawn = calls.find((call) => call.args.includes("respawn-pane"))!.args;
	assert.deepEqual(respawn.slice(0, 7), ["-S", "/tmp/tmux-1/default", "respawn-pane", "-k", "-t", "%5", "-c"]);
	assert.deepEqual(respawn.slice(8), ["env", "-u", "HERDR_CALLER", "-u", "HERDR_REMOVED", "-u", "HERDR_SERVER", "PI_SUBAGENT_MUX=tmux", "node", "x.mjs", "a; rm -rf $HOME 'q' && `id`"]);
	assert.ok(calls.some((call) => call.args.join(" ") === "-S /tmp/tmux-1/default set-option -w -t @4 remain-on-exit on"), "tmux retains exited pane for diagnostics");
	const created = calls[0].args;
	assert.ok(created.includes("-x") && created.includes("220") && created.includes("/work/my root"));
});

test("same-basename roots receive independent names; close rejects wrong socket, marker, run or pane", async () => {
	const { sessionName } = await import("../src/watch/hosts/tmux.ts");
	assert.notEqual(sessionName("/a/app", "11111111"), sessionName("/b/app", "11111111"));
	const handle = { v: 1, kind: "tmux", root: "/r", launchId: "L", name: "n", socket: "/s", sessionId: "$1", windowId: "@1", paneId: "%1", createdAt: "x" } as const;
	const good = "$1\t@1\t%1\t/s\t/r\tL\n";
	for (const [answer, closes] of [[good, true], ["$1\t@1\t%1\t/s\t/r\tOTHER\n", false], ["$1\t@1\t%1\t/other\t/r\tL\n", false], ["$2\t@1\t%1\t/s\t/r\tL\n", false], ["$1\t@1\t%1\t/s\t/elsewhere\tL\n", false]] as const) {
		const { exec, calls } = recording({ "display-message": answer });
		const host = tmuxHost({ exec, env: {} });
		if (closes) await host.close(handle);
		else await assert.rejects(host.close(handle), /no longer matches/);
		assert.equal(calls.some((call) => call.args.includes("kill-session")), closes);
		if (closes) assert.deepEqual(calls.at(-1)!.args, ["-S", "/s", "kill-session", "-t", "$1"]);
	}
});

test("tmux open rolls back its exact session when setup fails (R7)", async () => {
	const calls: (readonly string[])[] = [];
	const exec = async (args: readonly string[]) => {
		calls.push(args);
		if (args.includes("new-session")) return { code: 0, stdout: "$3\t@4\t%5\t/tmp/tmux-1/s\n", stderr: "" };
		if (args.includes("remain-on-exit")) return { code: 1, stdout: "", stderr: "injected failure" };
		return { code: 0, stdout: "", stderr: "" };
	};
	await assert.rejects(tmuxHost({ exec, env: {} }).open("/r", "launch-1", { title: "loop", argv: ["x"], env: {} }), /injected failure/);
	assert.deepEqual(calls.at(-1), ["-S", "/tmp/tmux-1/s", "kill-session", "-t", "$3"]);
	assert.equal(calls.some((args) => args.includes("respawn-pane")), false, "the role never started");
});

test("tmux open stops at the startup deadline and removes only its marked session (R6)", async () => {
	const calls: (readonly string[])[] = [];
	// new-session hangs until aborted; the server already created the session with its markers.
	const exec = async (args: readonly string[], _env: NodeJS.ProcessEnv, signal?: AbortSignal) => {
		calls.push(args);
		if (args.includes("new-session")) return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => signal?.addEventListener("abort", () => resolve({ code: 1, stdout: "", stderr: "killed" }), { once: true }));
		if (args.includes("list-sessions")) return { code: 0, stdout: "$7\tlaunch-1\n$8\tother\n$9\t\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const started = Date.now();
	await assert.rejects(tmuxHost({ exec, env: {}, server: ["-L", "x"] }).open("/r", "launch-1", { title: "loop", argv: ["x"], env: {} }, AbortSignal.timeout(100)));
	assert.ok(Date.now() - started < 1000);
	assert.deepEqual(calls.filter((args) => args.includes("kill-session")), [["-L", "x", "kill-session", "-t", "$7"]]);
	assert.ok(calls[0].includes("@ralph_launch") && calls[0].includes(";"), "markers are set in the creating command");
});

test("tmux open keeps the creation identity when an early marker fails (G3)", async () => {
	const calls: (readonly string[])[] = [];
	const exec = async (args: readonly string[]) => {
		calls.push(args);
		// The chain created the session and printed its identity, then the launch marker failed.
		if (args.includes("new-session")) return { code: 1, stdout: "$3\t@4\t%5\t/tmp/tmux-1/s\n", stderr: "injected launch-marker failure" };
		return { code: 0, stdout: "", stderr: "" };
	};
	await assert.rejects(tmuxHost({ exec, env: {} }).open("/r", "launch-1", { title: "loop", argv: ["x"], env: {} }), /injected launch-marker failure/);
	assert.deepEqual(calls.at(-1), ["-S", "/tmp/tmux-1/s", "kill-session", "-t", "$3"]);
});

test("scratch tmux early marker failure leaves no session (G3)", { skip: available ? false : "tmux unavailable" }, async (t) => {
	const server = `rw-t9-g3-${process.pid}-${randomUUID().slice(0, 8)}`;
	const tmux = (...args: string[]) => spawnSync("tmux", ["-L", server, ...args], { encoding: "utf8" });
	assert.equal(tmux("new-session", "-d", "-s", "sentinel", "sh", "-c", "exec tail -f /dev/null").status, 0);
	const socket = tmux("display-message", "-p", "#{socket_path}").stdout.trim();
	t.after(() => { tmux("kill-server"); rmSync(socket, { force: true }); });
	const { realTmux } = await import("../src/watch/hosts/tmux.ts");
	// Real tmux; only the launch-marker command targets a missing session so it fails.
	const exec = (args: readonly string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) => {
		const index = args.indexOf("@ralph_launch");
		return realTmux(index > 0 ? [...args.slice(0, index), "-t", "=missing-session", ...args.slice(index)] : args, env, signal);
	};
	await assert.rejects(tmuxHost({ exec, env: {}, server: ["-L", server] }).open(tmpdir(), "launch-g3", { title: "loop", argv: ["true"], env: {} }));
	assert.deepEqual(tmux("list-sessions", "-F", "#{session_name}").stdout.trim().split("\n"), ["sentinel"]);
});

test("tmux rollback after the startup deadline is bounded and reports what may remain (G4)", { timeout: 5_000 }, async () => {
	const hang = (signal?: AbortSignal) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => signal?.addEventListener("abort", () => resolve({ code: 1, stdout: "", stderr: "killed" }), { once: true }));
	// The stalled server stalls every client, including cleanup.
	const exec = async (_args: readonly string[], _env: NodeJS.ProcessEnv, signal?: AbortSignal) => hang(signal);
	const started = Date.now();
	await assert.rejects(tmuxHost({ exec, env: {}, cleanupMs: 100 }).open("/r", "launch-1", { title: "loop", argv: ["x"], env: {} }, AbortSignal.timeout(50)), /may remain: cleanup did not finish/);
	assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
});

test("pane state is dead only on positive evidence (G2)", async () => {
	const socket = join(tmpdir(), `rw-t9-g2-${process.pid}`);
	writeFileSync(socket, "");
	try {
		const handle = { v: 1, kind: "tmux", root: "/r", launchId: "L", name: "n", socket, sessionId: "$1", windowId: "@1", paneId: "%1", createdAt: "x" } as const;
		const id = `$1\t@1\t%1\t${socket}\t/r\tL`;
		const host = (display: { code: number; stdout: string }, panes: { code: number; stdout: string }) => tmuxHost({ env: {}, exec: async (args) => args.includes("list-panes") ? { ...panes, stderr: "" } : { ...display, stderr: "query failed" } });
		assert.equal(await host({ code: 0, stdout: `${id}\t1\n` }, { code: 0, stdout: "" }).paneDead(handle), true);
		assert.equal(await host({ code: 0, stdout: `${id}\t0\n` }, { code: 0, stdout: "" }).paneDead(handle), false);
		assert.equal(await host({ code: 1, stdout: "" }, { code: 0, stdout: "%2\n" }).paneDead(handle), true, "server proves the pane absent");
		await assert.rejects(host({ code: 1, stdout: "" }, { code: 0, stdout: "%1\n" }).paneDead(handle), /uncertain/);
		await assert.rejects(host({ code: 1, stdout: "" }, { code: 1, stdout: "" }).paneDead(handle), /uncertain/);
		await assert.rejects(host({ code: 0, stdout: "garbage\n" }, { code: 0, stdout: "" }).paneDead(handle), /uncertain/);
	} finally { rmSync(socket, { force: true }); }
});
