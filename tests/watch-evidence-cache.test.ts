import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { openLoop } from "../src/watch/loop-state.ts";
import { Fixture, clock, T } from "./fixtures/loop-state.ts";

test("unchanged warm polls reuse live evidence; content, index, untracked, mode and mission edits invalidate it", async () => {
	const f = new Fixture([], { plain: true }); let diffs = 0;
	const base = clock();
	const reader = openLoop(f.root, { runtime: { ...base, async git(root, args, signal) { if (args[0] === "diff") diffs++; return base.git(root, args, signal); } } });
	try {
		writeFileSync(path.join(f.root, "a.ts"), "const a = 1;\n"); f.commit("a", T("09:10"));
		writeFileSync(path.join(f.root, "a.ts"), "const a = 2;\n");
		const first = await reader.read(); assert.ok(first.evidence); diffs = 0;
		const warm = await reader.read(); assert.equal(diffs, 0); assert.deepEqual(warm.evidence, first.evidence);
		for (const edit of [
			() => writeFileSync(path.join(f.root, "a.ts"), "// @ts-ignore\n"),
			() => f.git("add", "a.ts"),
			() => { writeFileSync(path.join(f.root, "a.ts"), "const a = 1;\n"); f.git("add", "a.ts"); },
			() => writeFileSync(path.join(f.root, "new.ts"), "const b = 1;\n"),
			() => chmodSync(path.join(f.root, "a.ts"), 0o755),
			() => writeFileSync(path.join(f.root, ".ralph/mission.json"), "{}"),
		]) { diffs = 0; edit(); const s = await reader.read(); assert.ok(s.git); assert.ok(diffs > 0); }
		diffs = 0;
		writeFileSync(path.join(f.root, ".ralph/enforcer-alerts.jsonl"), "");
		await reader.read(); assert.equal(diffs, 0);
	} finally { await reader.close(); f.close(); }
});

test("probe stamps ignore operational runtime files but retain item, progress and mission policy edits", async () => {
	const { readGitVersion } = await import("../src/watch/loop-state.ts");
	const { mkdirSync, readFileSync } = await import("node:fs");
	const f = new Fixture([], { plain: true });
	try {
		writeFileSync(path.join(f.root, ".gitignore"), "");
		const before = await readGitVersion(f.root);
		mkdirSync(path.join(f.root, ".ralph/steer"));
		for (const name of ["loop.md", "driver.json", "driver.lock", "launch.lock", "rpc.in", "watch-host.json", "launch-9b9fe773-a490-413a-9e0b-33515c5f0ad1.json", "driver.json.123.tmp", "watch-host.json.123.tmp", "steer/9b9fe773-a490-413a-9e0b-33515c5f0ad1.txt", "journal.jsonl", "journal.1.jsonl", "enforcer.json", "enforcer-alerts.jsonl"]) {
			writeFileSync(path.join(f.root, ".ralph", name), "runtime update\n");
			assert.equal(await readGitVersion(f.root), before, name);
		}
		for (const name of ["items.json", "progress.md", "mission.json", "steer/helper.ts", "steer/request.txt", "launch-notes.json"]) {
			const file = path.join(f.root, ".ralph", name);
			const prior = await readGitVersion(f.root);
			let text = ""; try { text = readFileSync(file, "utf8"); } catch { /* New author files are also relevant. */ }
			writeFileSync(file, `${text}\n`);
			assert.notEqual(await readGitVersion(f.root), prior, name);
		}
	} finally { f.close(); }
});

test("an author edit under steer invalidates warm evidence without an unrelated edit", async () => {
	const { mkdirSync } = await import("node:fs");
	const { evaluate } = await import("../src/watch/enforcer.ts");
	const f = new Fixture([], { plain: true }); const reader = openLoop(f.root, { runtime: clock() });
	try {
		mkdirSync(path.join(f.root, ".ralph/steer"));
		const file = path.join(f.root, ".ralph/steer/helper.ts");
		writeFileSync(file, "const helper = 1;\n");
		await reader.read(); await reader.read();
		writeFileSync(file, "// @ts-ignore\nconst helper = 1;\n");
		const snapshot = await reader.read();
		assert.ok(snapshot.mission);
		assert.ok(evaluate(snapshot, snapshot.mission, { branch: f.git("symbolic-ref", "--short", "HEAD") }).some(a => a.rule === "suppression-comment" && a.level === "HARD"));
	} finally { await reader.close(); f.close(); }
});

test("runtime-named changes invalidate full observation evidence but not the probe digest", async () => {
	const { readGitVersion } = await import("../src/watch/loop-state.ts");
	const f = new Fixture([], { plain: true }); let diffs = 0; const base = clock();
	const reader = openLoop(f.root, { runtime: { ...base, async git(root, args, signal) { if (args[0] === "diff") diffs++; return base.git(root, args, signal); } } });
	try {
		writeFileSync(path.join(f.root, ".ralph/driver.lock"), "100\n");
		const first = await reader.read(); const version = await readGitVersion(f.root); diffs = 0;
		writeFileSync(path.join(f.root, ".ralph/driver.lock"), "101\n");
		const second = await reader.read();
		assert.ok(diffs > 0, "full stamp must invalidate cached path-level evidence");
		assert.equal(second.gitVersion, first.gitVersion); assert.equal(await readGitVersion(f.root), version);
	} finally { await reader.close(); f.close(); }
});

test("a runtime-named path changing within the observation still makes it torn", async () => {
	const f = new Fixture([], { plain: true }); const base = clock(); let armed = false;
	const lock = path.join(f.root, ".ralph/driver.lock"); writeFileSync(lock, "100\n");
	const reader = openLoop(f.root, { runtime: { ...base, async git(root, args, signal) {
		const result = await base.git(root, args, signal);
		if (armed && args[0] === "diff") { armed = false; writeFileSync(lock, "101\n"); }
		return result;
	} } });
	try {
		await reader.read(); writeFileSync(path.join(f.root, "cache-trigger.txt"), "rebuild evidence\n"); armed = true;
		const snapshot = await reader.read();
		assert.equal(armed, false); assert.equal(snapshot.evidence, null);
		assert.ok(snapshot.issues.some(i => i.source === "git" && i.kind === "concurrent"));
	} finally { await reader.close(); f.close(); }
});
