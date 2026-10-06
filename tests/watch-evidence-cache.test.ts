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
		for (const name of ["loop.md", "driver.json", "driver.lock", "launch.lock", "rpc.in", "watch-host.json", "launch-owned.json", "driver.json.123.tmp", "watch-host.json.123.tmp", "steer/note.txt", "journal.jsonl", "journal.1.jsonl", "enforcer.json", "enforcer-alerts.jsonl"]) {
			writeFileSync(path.join(f.root, ".ralph", name), "runtime update\n");
			assert.equal(await readGitVersion(f.root), before, name);
		}
		for (const name of ["items.json", "progress.md", "mission.json"]) {
			const file = path.join(f.root, ".ralph", name);
			const prior = await readGitVersion(f.root); writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
			assert.notEqual(await readGitVersion(f.root), prior, name);
		}
	} finally { f.close(); }
});
