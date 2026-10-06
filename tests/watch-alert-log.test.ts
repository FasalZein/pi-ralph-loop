import assert from "node:assert/strict";
import { readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appendAlerts, readAlerts, readEnforcerStatus, writeEnforcerStatus, type EnforcerStatus } from "../src/watch/alert-log.ts";
import { readOnce, Fixture, T } from "./fixtures/loop-state.ts";

const run = { launchId: "log", loopToken: null, startedAt: null };
const status: EnforcerStatus = { v: 1, pid: process.pid, run, configHash: "hash", state: "ready", polledAt: T("12:00"), commitsChecked: 1, counts: { HARD: 0, WARN: 0, INFO: 0 }, stop: null };
test("alert evidence appends without changing earlier bytes; records round-trip through the parser", async () => {
	const f = new Fixture([], { plain: true });
	try {
		const first = { timestamp: T("12:00"), level: "HARD" as const, rule: "suppression-comment", run, item: null, commit: null, evidence: ["line 1"] };
		await appendAlerts(f.root, [first]);
		const prefix = readFileSync(join(f.root, ".ralph/enforcer-alerts.jsonl"), "utf8");
		await appendAlerts(f.root, [{ ...first, rule: "test-focus" }]);
		assert.ok(readFileSync(join(f.root, ".ralph/enforcer-alerts.jsonl"), "utf8").startsWith(prefix));
		assert.deepEqual(await readAlerts(f.root), [first, { ...first, rule: "test-focus" }]);
	} finally { f.close(); }
});
test("failed atomic status writes remove their temporary file and permit recovery", async () => {
	const f = new Fixture([], { plain: true });
	try {
		await writeEnforcerStatus(f.root, status);
		await assert.rejects(writeEnforcerStatus(f.root, { ...status, get polledAt(): string { throw new Error("write interrupted"); } }), /write interrupted/);
		assert.deepEqual(await readEnforcerStatus(f.root), status);
		assert.equal(readdirSync(join(f.root, ".ralph")).some(name => name.endsWith(".tmp")), false);
		await writeEnforcerStatus(f.root, { ...status, state: "unavailable" });
		assert.equal((await readEnforcerStatus(f.root))?.state, "unavailable");
	} finally { f.close(); }
});
test("malformed evidence remains unavailable in the snapshot instead of displaying a clean verdict", async () => {
	const f = new Fixture([], { plain: true });
	try {
		await writeEnforcerStatus(f.root, status);
		writeFileSync(join(f.root, ".ralph/enforcer-alerts.jsonl"), '{"unfinished":');
		const snapshot = await readOnce(f);
		assert.equal(snapshot.enforcer?.status.state, "unavailable");
		assert.ok(snapshot.issues.some(i => i.source === "enforcer"));
	} finally { f.close(); }
});
test("the evidence boundary refuses symlink files", async () => {
	const f = new Fixture([], { plain: true });
	try {
		const target = join(f.root, "target"); writeFileSync(target, "original");
		symlinkSync(target, join(f.root, ".ralph/enforcer-alerts.jsonl"));
		await assert.rejects(readAlerts(f.root));
		await assert.rejects(appendAlerts(f.root, [{ timestamp: T("12:00"), level: "HARD", rule: "test-focus", run, item: null, commit: null, evidence: [] }]));
		assert.equal(readFileSync(target, "utf8"), "original");
	} finally { f.close(); }
});
