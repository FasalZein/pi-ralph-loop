import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadMission } from "../src/watch/config.ts";
import { runEnforcer } from "../src/watch/enforcer-process.ts";
import { Fixture, clock, T } from "./fixtures/loop-state.ts";

test("33 stop-routing: durable HARD evidence and stop intent precede the injected stop; repeated polls latch", async () => {
	const f = new Fixture([], { plain: true });
	const abort = new AbortController(); let polls = 0; let stops = 0;
	try {
		writeFileSync(path.join(f.root, "bad.ts"), "// @ts-ignore\nconst x = 1;\n");
		const mission = await loadMission(f.root);
		await runEnforcer({ root: f.root, mission, run: { launchId: "one", loopToken: null, startedAt: null }, branch: f.git("symbolic-ref", "--short", "HEAD") }, {
			signal: abort.signal, observation: clock(), log: () => {},
			async stop(run) {
				stops++;
				assert.match(readFileSync(path.join(f.root, ".ralph/enforcer-alerts.jsonl"), "utf8"), /suppression-comment/);
				assert.equal(JSON.parse(readFileSync(path.join(f.root, ".ralph/enforcer.json"), "utf8")).stop.phase, "intent");
				return { id: "s", run, phase: "accepted" };
			},
			async sleep(ms) { assert.equal(ms, 10_000); if (++polls === 3) abort.abort(); },
		});
		assert.equal(stops, 1);
		const lines = readFileSync(path.join(f.root, ".ralph/enforcer-alerts.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
		assert.equal(lines.filter(a => a.rule === "suppression-comment").length, 1);
	} finally { f.close(); }
});

test("34 liveness: stale, stalled and rising counters are records only; STOPPED produces one final summary", async () => {
	const f = new Fixture([], { plain: true }); let polls = 0; let stops = 0;
	try {
		f.state(true, T("09:00"), "token", { owner_heartbeat_at: T("09:00") });
		const mission = await loadMission(f.root);
		const result = await runEnforcer({ root: f.root, mission, run: { launchId: "live", loopToken: "token", startedAt: T("09:00") }, branch: f.git("symbolic-ref", "--short", "HEAD") }, {
			observation: clock(), log: () => {},
			async *events(_target, signal) {
				yield { v: 1, type: "hello", launchId: "live", pid: process.pid, nextSeq: 0, lastPiAt: T("09:00"), loop: { token: "token", startedAt: T("09:00"), iteration: 1 }, tools: [], totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0, dialogsCancelled: 0, refusals: 0 }, counters: { dialogsCancelled: 0, refusals: 0, badRecords: 0, badFacts: 0, subscriberDrops: 0 }, state: "launched" };
				await new Promise<void>(r => signal?.addEventListener("abort", () => r(), { once: true }));
			},
			async stop(run) { stops++; return { id: "s", run, phase: "accepted" }; },
			async sleep() {
				polls++;
				f.state(polls < 2, T("09:00"), "token", { owner_heartbeat_at: T("09:00"), error_count: 1, bundle_rejection_count: 1 });
			},
		});
		assert.equal(result.reason, "stopped"); assert.equal(stops, 0);
		const rules = readFileSync(path.join(f.root, ".ralph/enforcer-alerts.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s).rule);
		assert.deepEqual(rules, ["heartbeat-stale", "rpc-stall", "error_count-rise", "bundle_rejection_count-rise", "loop-ended"]);
	} finally { f.close(); }
});

test("evidence append failure forbids stop and publishes unavailable; next poll recovers", async () => {
	const f = new Fixture([], { plain: true }); const abort = new AbortController(); let polls = 0; let stops = 0;
	try {
		writeFileSync(path.join(f.root, "bad.ts"), "// @ts-ignore\n");
		const { appendAlerts } = await import("../src/watch/alert-log.ts");
		await runEnforcer({ root: f.root, mission: await loadMission(f.root), run: { launchId: "failure", loopToken: null, startedAt: null }, branch: f.git("symbolic-ref", "--short", "HEAD") }, {
			signal: abort.signal, observation: clock(), log: () => {},
			async append(root, alerts) { if (!polls) throw new Error("disk full"); await appendAlerts(root, alerts); },
			async stop(run) { stops++; return { id: "s", run, phase: "accepted" }; },
			async sleep() {
				if (!polls) { assert.equal(stops, 0); assert.equal(JSON.parse(readFileSync(path.join(f.root, ".ralph/enforcer.json"), "utf8")).state, "unavailable"); }
				if (++polls === 2) abort.abort();
			},
		});
		assert.equal(stops, 1);
	} finally { f.close(); }
});

test("crash after send but before receipt persistence resends; new launch never inherits the latch", async () => {
	const f = new Fixture([], { plain: true }); let stops = 0;
	try {
		writeFileSync(path.join(f.root, "bad.ts"), "// @ts-ignore\n"); f.commit("bad", T("10:00"));
		const mission = await loadMission(f.root);
		const { writeEnforcerStatus } = await import("../src/watch/alert-log.ts");
		for (const id of ["first", "first", "second"]) {
			const abort = new AbortController(); let calls = 0;
			await runEnforcer({ root: f.root, mission, run: { launchId: id, loopToken: null, startedAt: null }, branch: f.git("symbolic-ref", "--short", "HEAD") }, {
				signal: abort.signal, observation: clock(), log: () => {},
				async writeStatus(root, status) { if (id === "first" && stops === 1 && status.stop?.phase === "accepted") throw new Error("crash at receipt persistence"); await writeEnforcerStatus(root, status); },
				async stop(run) { stops++; calls++; return { id: "s", run, phase: "accepted" }; },
				async sleep() { abort.abort(); },
			});
			assert.equal(calls, 1);
		}
		assert.equal(stops, 3);
	} finally { f.close(); }
});

test("validated config changes are HARD; malformed reload is WARN and retries without relaxing pinned rules", async () => {
	const f = new Fixture([], { plain: true }); const abort = new AbortController(); let polls = 0; let stops = 0;
	try {
		const config = path.join(f.root, ".ralph/mission.json"); const original = JSON.parse(readFileSync(config, "utf8"));
		const mission = await loadMission(f.root);
		await runEnforcer({ root: f.root, mission, run: { launchId: "config", loopToken: null, startedAt: null }, branch: f.git("symbolic-ref", "--short", "HEAD") }, {
			signal: abort.signal, observation: clock(), log: () => {},
			async stop(run) { stops++; return { id: "s", run, phase: "accepted" }; },
			async sleep() {
				if (++polls === 1) writeFileSync(config, "{");
				else if (polls === 2) { assert.equal(stops, 0); writeFileSync(config, JSON.stringify({ ...original, rules: { "suppression-comment": "off" } })); }
				else abort.abort();
			},
		});
		assert.equal(stops, 1);
		const log = readFileSync(path.join(f.root, ".ralph/enforcer-alerts.jsonl"), "utf8");
		assert.match(log, /config-reload-unavailable/); assert.match(log, /config-changed/);
	} finally { f.close(); }
});

test("failed and sent stops retry on later polls; accepted closes the run latch", async () => {
	const f = new Fixture([], { plain: true }); const abort = new AbortController(); let polls = 0; let stops = 0;
	try {
		writeFileSync(path.join(f.root, "bad.ts"), "// @ts-ignore\n");
		await runEnforcer({ root: f.root, mission: await loadMission(f.root), run: { launchId: "retry", loopToken: null, startedAt: null }, branch: f.git("symbolic-ref", "--short", "HEAD") }, {
			signal: abort.signal, observation: clock(), log: () => {},
			async stop(run) { if (++stops === 1) throw new Error("driver temporarily unavailable"); return { id: "s", run, phase: stops === 2 ? "sent" : "accepted" }; },
			async sleep() { if (++polls === 4) abort.abort(); },
		});
		assert.equal(stops, 3);
		const log = readFileSync(path.join(f.root, ".ralph/enforcer-alerts.jsonl"), "utf8");
		assert.match(log, /driver temporarily unavailable/); assert.match(log, /sent/); assert.match(log, /accepted/);
	} finally { f.close(); }
});

test("relaunch rechecks live HARD evidence, records repaired evidence as resolved, and never sends a stop for a clean control", async () => {
	const f = new Fixture([], { plain: true }); let stops = 0;
	try {
		const bad = path.join(f.root, "bad.ts"); writeFileSync(bad, "// @ts-ignore\n");
		const mission = await loadMission(f.root);
		for (const id of ["first", "second", "repaired"]) {
			if (id === "repaired") writeFileSync(bad, "const a = 1;\n");
			const abort = new AbortController();
			await runEnforcer({ root: f.root, mission, run: { launchId: id, loopToken: null, startedAt: null }, branch: f.git("symbolic-ref", "--short", "HEAD") }, {
				signal: abort.signal, observation: clock(), log: () => {},
				async stop(run) { stops++; return { id: "s", run, phase: "accepted" }; },
				async sleep() { abort.abort(); },
			});
		}
		assert.equal(stops, 2);
		const records = readFileSync(path.join(f.root, ".ralph/enforcer-alerts.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
		assert.equal(records.filter(a => a.rule === "hard-resolved" && a.run.launchId === "repaired").length, 2);
	} finally { f.close(); }
});

test("status intent persistence failure forbids dispatch even when HARD evidence is durable", async () => {
	const f = new Fixture([], { plain: true }); const abort = new AbortController(); let stops = 0;
	try {
		writeFileSync(path.join(f.root, "bad.ts"), "// @ts-ignore\n");
		await runEnforcer({ root: f.root, mission: await loadMission(f.root), run: { launchId: "intent", loopToken: null, startedAt: null }, branch: f.git("symbolic-ref", "--short", "HEAD") }, {
			signal: abort.signal, observation: clock(), log: () => {},
			async writeStatus() { throw new Error("cannot persist intent"); },
			async stop(run) { stops++; return { id: "s", run, phase: "accepted" }; },
			async sleep() { abort.abort(); },
		});
		assert.equal(stops, 0); assert.match(readFileSync(path.join(f.root, ".ralph/enforcer-alerts.jsonl"), "utf8"), /suppression-comment/);
	} finally { f.close(); }
});

test("non-blocking debt probes enforce measured rises only from the unchanged worktree version", async () => {
	const f = new Fixture([], { plain: true, extra: { rules: { "debt-measure-rise": "hard" }, measure: { command: [process.execPath, "-e", 'console.log(JSON.stringify({debt:1}))'], start: { debt: 0 } } } });
	const abort = new AbortController(); let polls = 0; let stops = 0;
	try {
		await runEnforcer({ root: f.root, mission: await loadMission(f.root), run: { launchId: "measure", loopToken: null, startedAt: null }, branch: f.git("symbolic-ref", "--short", "HEAD") }, {
			signal: abort.signal, observation: clock(), log: () => {},
			async stop(run) { stops++; return { id: "s", run, phase: "accepted" }; },
			async sleep() { if (++polls === 3) abort.abort(); else await new Promise(r => setTimeout(r, 100)); },
		});
		assert.equal(stops, 1);
		const log = readFileSync(path.join(f.root, ".ralph/enforcer-alerts.jsonl"), "utf8");
		assert.match(log, /measure-unavailable/); assert.match(log, /debt-measure-rise/);
	} finally { f.close(); }
});

test("a partially written alert batch prevents later stops instead of appending past lost evidence", async () => {
	const f = new Fixture([], { plain: true }); const abort = new AbortController(); let polls = 0; let stops = 0;
	try {
		writeFileSync(path.join(f.root, "bad.ts"), "// @ts-ignore\n");
		const { appendAlerts } = await import("../src/watch/alert-log.ts");
		await runEnforcer({ root: f.root, mission: await loadMission(f.root), run: { launchId: "partial", loopToken: null, startedAt: null }, branch: f.git("symbolic-ref", "--short", "HEAD") }, {
			signal: abort.signal, observation: clock(), log: () => {},
			async append(root, records) { if (!polls) { writeFileSync(path.join(root, ".ralph/enforcer-alerts.jsonl"), '{"rule":'); throw new Error("partial write"); } await appendAlerts(root, records); },
			async stop(run) { stops++; return { id: "s", run, phase: "accepted" }; },
			async sleep() { assert.equal(JSON.parse(readFileSync(path.join(f.root, ".ralph/enforcer.json"), "utf8")).state, "unavailable"); if (++polls === 2) abort.abort(); },
		});
		assert.equal(stops, 0);
	} finally { f.close(); }
});

test("restarting after STOPPED does not append another final summary for the same launch", async () => {
	const f = new Fixture([], { plain: true });
	try {
		f.state(false, T("09:00"), "terminal");
		const spec = { root: f.root, mission: await loadMission(f.root), run: { launchId: "finished", loopToken: "terminal", startedAt: T("09:00") }, branch: f.git("symbolic-ref", "--short", "HEAD") };
		for (let n = 0; n < 2; n++) assert.equal((await runEnforcer(spec, { observation: clock(), log: () => {}, async stop() { throw new Error("terminal loops never stop again"); } })).reason, "stopped");
		const records = readFileSync(path.join(f.root, ".ralph/enforcer-alerts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.equal(records.filter(a => a.rule === "loop-ended").length, 1);
	} finally { f.close(); }
});
