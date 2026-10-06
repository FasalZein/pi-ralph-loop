import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { LoopSnapshot } from "../src/watch/types.ts";
import { detailBody, itemCommits, proofState } from "../src/watch/viewer/detail.ts";
import { DIFF_CAP_BYTES, diffLines, showCommit } from "../src/watch/viewer/diff.ts";
import { progressBody, progressTitle } from "../src/watch/viewer/progress-screen.ts";
import { Fixture, readOnce, T } from "./fixtures/loop-state.ts";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const write = (f: Fixture, file: string, text: string) => {
	mkdirSync(path.dirname(path.join(f.root, file)), { recursive: true });
	writeFileSync(path.join(f.root, file), text);
};

// ---- Diff ----

test("diff lines: sanitized first, then file headers bold, hunks accent, additions green, removals red", () => {
	const text = [
		"commit 0123456789abcdef0123456789abcdef01234567",
		"diff --git a/x.ts b/x.ts",
		"--- a/x.ts",
		"+++ b/x.ts",
		"@@ -1,2 +1,2 @@",
		" same",
		"-old \x1b]0;pwn\x07line",
		"+new \x1b[31mline",
	].join("\n");
	const lines = diffLines({ text, truncated: false });
	assert.equal(lines.length, 8);
	assert.equal(lines[1], "\x1b[1mdiff --git a/x.ts b/x.ts\x1b[0m");
	assert.equal(lines[4], "\x1b[38;2;236;124;64m@@ -1,2 +1,2 @@\x1b[0m");
	assert.equal(lines[5], " same");
	// Hostile sequences are gone; only the trusted colour remains.
	assert.equal(lines[6], "\x1b[31m-old line\x1b[0m");
	assert.equal(lines[7], "\x1b[32m+new line\x1b[0m");
	assert.ok(!lines.join("").includes("pwn"));
	// Owner Q3 on #16: a truncated read ends in one truncation line.
	assert.equal(plain(diffLines({ text: "+a", truncated: true }).at(-1)!), "⚠ diff truncated at 1 MiB of git output");
});

test("showCommit reads a verified commit read-only, caps the output at 1 MiB and reports git errors", async (t) => {
	const f = new Fixture([{ id: "A", passes: false }]);
	t.after(() => f.close());
	write(f, "src/a.ts", "export const a = 1;\n");
	const small = f.commit("feat: a", T("10:00"));
	const shown = await showCommit(f.root, small, new AbortController().signal);
	assert.equal(shown.truncated, false);
	assert.match(shown.text, /^commit [0-9a-f]{40}\nfeat: a\n/);
	assert.match(shown.text, /\ndiff --git a\/src\/a\.ts b\/src\/a\.ts\n/);
	assert.match(shown.text, /\n\+export const a = 1;\n/);

	// 2 MiB of added lines: the read stops at the cap and drops the partial last line.
	write(f, "big.txt", `${"x".repeat(99)}\n`.repeat(2 * 1024 * 1024 / 100));
	const big = f.commit("chore: big", T("10:10"));
	const capped = await showCommit(f.root, big, new AbortController().signal);
	assert.equal(capped.truncated, true);
	assert.ok(Buffer.byteLength(capped.text) <= DIFF_CAP_BYTES);
	assert.ok(capped.text.endsWith("x".repeat(99)));

	await assert.rejects(showCommit(f.root, "HEAD", new AbortController().signal), /not a full commit id/);
	await assert.rejects(showCommit(f.root, "f".repeat(40), new AbortController().signal), /git show exited 128/);
});

// ---- Item commits ----

test("item commits: pass, approved parent inside the span, and blocker, newest first (capture detail-05)", async (t) => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	t.after(() => f.close());
	f.pass("A", T("10:00"));
	const blocker = f.block("B", T("10:10"));
	write(f, "owner.txt", "owner fix\n");
	const parent = f.commit("fix: owner", T("10:20"));
	write(f, "src/b.ts", "b\n");
	const pass = f.pass("B", T("10:30"));
	// Approve the parent commit by exact SHA (spec #1 story 8). The mission is read at read time.
	const missionFile = path.join(f.root, ".ralph/mission.json");
	const mission = JSON.parse((await import("node:fs")).readFileSync(missionFile, "utf8"));
	mission.git.parentCommits = [{ sha: parent, reason: "owner fix" }];
	writeFileSync(missionFile, JSON.stringify(mission));
	const s = await readOnce(f);
	assert.deepEqual(itemCommits(s, "B").map((c) => [c.sha, c.kind]), [[pass, "item-pass"], [parent, "parent"], [blocker, "blocker"]]);
	// A's span ends at its own pass: the later parent commit is not A's.
	assert.deepEqual(itemCommits(s, "A").map((c) => c.kind), ["item-pass"]);
	// No fresh history, no commits.
	assert.deepEqual(itemCommits({ ...s, git: null }, "B"), []);
});

test("item commits: a regressed item keeps the approved owner repair before its second pass", async (t) => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	t.after(() => f.close());
	const first = f.pass("A", T("10:00"));
	// A regresses (the bundle contract lets a passing item fall back), blocks, gets an owner repair and passes again.
	f.items = f.items.map((i) => (i.id === "A" ? { ...i, passes: false, regression_notes: "broke" } : i));
	f.writeBundle();
	f.commit("chore: regress A", T("10:10"));
	const blocker = f.block("A", T("10:20"));
	write(f, "owner.txt", "repair\n");
	const repair = f.commit("fix: owner repair", T("10:30"));
	const second = f.pass("A", T("10:40"));
	write(f, "late.txt", "after\n");
	const late = f.commit("fix: owner late", T("10:50"));
	const missionFile = path.join(f.root, ".ralph/mission.json");
	const mission = JSON.parse((await import("node:fs")).readFileSync(missionFile, "utf8"));
	mission.git.parentCommits = [{ sha: repair, reason: "owner repair" }, { sha: late, reason: "owner late" }];
	writeFileSync(missionFile, JSON.stringify(mission));
	const s = await readOnce(f);
	assert.deepEqual(itemCommits(s, "A").map((c) => [c.sha, c.kind]), [[second, "item-pass"], [repair, "parent"], [blocker, "blocker"], [first, "item-pass"]]);
	// The parent commit after A's last pass belongs to the open span of B, the current item.
	assert.deepEqual(itemCommits(s, "B").map((c) => [c.sha, c.kind]), [[late, "parent"]]);
});

test("item commits: an owner repair made while another item was current stays with that item after a regression", async (t) => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	t.after(() => f.close());
	const first = f.pass("A", T("10:00"));
	// B is current: the owner repairs B.
	write(f, "b.txt", "repair b\n");
	const repairB = f.commit("fix: owner repairs B", T("10:10"));
	// A regresses and becomes current again; the owner repairs A; A passes again.
	f.items = f.items.map((i) => (i.id === "A" ? { ...i, passes: false, regression_notes: "broke" } : i));
	f.writeBundle();
	f.commit("chore: regress A", T("10:20"));
	write(f, "a.txt", "repair a\n");
	const repairA = f.commit("fix: owner repairs A", T("10:30"));
	const second = f.pass("A", T("10:40"));
	const missionFile = path.join(f.root, ".ralph/mission.json");
	const mission = JSON.parse((await import("node:fs")).readFileSync(missionFile, "utf8"));
	mission.git.parentCommits = [{ sha: repairB, reason: "owner repairs B" }, { sha: repairA, reason: "owner repairs A" }];
	writeFileSync(missionFile, JSON.stringify(mission));
	const s = await readOnce(f);
	assert.deepEqual(itemCommits(s, "A").map((c) => [c.sha, c.kind]), [[second, "item-pass"], [repairA, "parent"], [first, "item-pass"]]);
	assert.deepEqual(itemCommits(s, "B").map((c) => [c.sha, c.kind]), [[repairB, "parent"]]);
	// Without item-transition evidence the reopened span is unknown: no parent commit is attributed to A.
	assert.deepEqual(itemCommits({ ...s, evidence: null }, "A").map((c) => c.kind), ["item-pass", "item-pass"]);
});

test("item commits: a repair made after later items passed belongs to the then-current item, not a passed one", async (t) => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }, { id: "C", passes: false }, { id: "D", passes: false }]);
	t.after(() => f.close());
	f.pass("A", T("10:00"));
	const passB = f.pass("B", T("10:10"));
	f.pass("C", T("10:20"));
	write(f, "d.txt", "repair d\n");
	const repairD = f.commit("fix: owner repairs D", T("10:30"));
	f.items = f.items.map((i) => (i.id === "A" ? { ...i, passes: false, regression_notes: "broke" } : i));
	f.writeBundle();
	f.commit("chore: regress A", T("10:40"));
	const missionFile = path.join(f.root, ".ralph/mission.json");
	const mission = JSON.parse((await import("node:fs")).readFileSync(missionFile, "utf8"));
	mission.git.parentCommits = [{ sha: repairD, reason: "owner repairs D" }];
	writeFileSync(missionFile, JSON.stringify(mission));
	const s = await readOnce(f);
	assert.deepEqual(itemCommits(s, "B").map((c) => c.sha), [passB]);
	assert.deepEqual(itemCommits(s, "D").map((c) => c.sha), [repairD]);
	assert.deepEqual(itemCommits(s, "A").map((c) => c.kind), ["item-pass"]);
});

test("item commits: a plain task attributes no commit to any item", async (t) => {
	const f = new Fixture([], { plain: true });
	t.after(() => f.close());
	write(f, "x.txt", "x\n");
	const sha = f.commit("fix: owner", T("10:00"));
	const missionFile = path.join(f.root, ".ralph/mission.json");
	const mission = JSON.parse((await import("node:fs")).readFileSync(missionFile, "utf8"));
	mission.git.parentCommits = [{ sha, reason: "owner" }];
	writeFileSync(missionFile, JSON.stringify(mission));
	const s = await readOnce(f);
	assert.equal(s.task, "plain");
	assert.ok(s.git?.commits?.some((c) => c.sha === sha && c.kind === "parent"));
	assert.deepEqual(itemCommits(s, "index:0"), []);
});

// ---- Stale proof (owner Q1 pass-commit-proof, Q2 scope-then-source on #16) ----

/** Item A with scope `src/ws`, passed by a commit that edits `src/ws/a.ts`. */
function scopedPass(t: test.TestContext, scope: Record<string, unknown>): Fixture {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }], { extra: { scope } });
	t.after(() => f.close());
	return f;
}

test("proof: passed at the pass commit until a later edit to the item scope paths makes it stale", async (t) => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	t.after(() => f.close());
	write(f, "src/ws/a.ts", "a\n");
	f.commit("chore: scaffold", T("09:30"));
	const missionFile = path.join(f.root, ".ralph/mission.json");
	const fs = await import("node:fs");
	const setScope = (scope: Record<string, unknown>) => {
		const mission = JSON.parse(fs.readFileSync(missionFile, "utf8"));
		mission.scope = scope;
		writeFileSync(missionFile, JSON.stringify(mission));
	};
	setScope({ items: [{ id: "A", allowedPaths: ["src/ws"] }] });
	write(f, "src/ws/a.ts", "a2\n");
	const pass = f.pass("A", T("10:00"));

	let s = await readOnce(f);
	assert.deepEqual(proofState(s, "A"), { state: "passed", sha: pass });

	// An unrelated later commit keeps the proof.
	write(f, "docs/x.md", "doc\n");
	f.commit("docs: x", T("10:10"));
	s = await readOnce(f);
	assert.deepEqual(proofState(s, "A"), { state: "passed", sha: pass });

	// An uncommitted worktree edit to a scope path makes it stale.
	write(f, "src/ws/a.ts", "a3\n");
	s = await readOnce(f);
	assert.deepEqual(proofState(s, "A"), { state: "stale", sha: pass, path: "src/ws/a.ts", where: "worktree" });

	// A later commit that edits a scope path makes it stale at that commit.
	const later = f.commit("feat: touch ws", T("10:20"));
	s = await readOnce(f);
	assert.deepEqual(proofState(s, "A"), { state: "stale", sha: pass, path: "src/ws/a.ts", where: later.slice(0, 7) });
	// Detail shows the marker in the Gates row only when the bundle has gates; the card glyph comes from the proof.
	assert.equal(proofState(s, "B").state, "unknown");

	// Missing evidence is unknown, never stale or passed.
	assert.deepEqual(proofState({ ...s, evidence: null }, "A"), { state: "unknown" });
	assert.deepEqual(proofState({ ...s, git: null }, "A"), { state: "unknown" });
	const torn: LoopSnapshot = { ...s, evidence: { ...s.evidence!, commits: {}, worktree: { status: "unavailable", error: "torn" } } };
	assert.deepEqual(proofState(torn, "A"), { state: "unknown" });
});

test("proof: without item scope, configured source discovery decides; no configured paths is unknown", async (t) => {
	const f = scopedPass(t, { sourceGlobs: ["src/**"] });
	write(f, "src/a.ts", "a\n");
	const pass = f.pass("A", T("10:00"));
	let s = await readOnce(f);
	assert.deepEqual(proofState(s, "A"), { state: "passed", sha: pass });
	write(f, "src/other.ts", "o\n");
	const later = f.commit("feat: other", T("10:10"));
	s = await readOnce(f);
	assert.deepEqual(proofState(s, "A"), { state: "stale", sha: pass, path: "src/other.ts", where: later.slice(0, 7) });

	const g = scopedPass(t, {});
	write(g, "src/a.ts", "a\n");
	g.pass("A", T("10:00"));
	write(g, "src/other.ts", "o\n");
	g.commit("feat: other", T("10:10"));
	assert.deepEqual(proofState(await readOnce(g), "A"), { state: "unknown" });
});

test("detail body: status line, raw and parsed cards, commits with files, steps and gates with the proof marker", async (t) => {
	const f = new Fixture([{ id: "A", title: "Login", passes: false }, { id: "B", passes: false }], { extra: { scope: { sourceGlobs: ["src/**"] } } });
	t.after(() => f.close());
	// Verification gates live in the bundle runtime contract.
	const itemsFile = path.join(f.root, ".ralph/items.json");
	const fs = await import("node:fs");
	const original = f.writeBundle.bind(f);
	f.writeBundle = () => {
		original();
		const doc = JSON.parse(fs.readFileSync(itemsFile, "utf8"));
		doc.runtime_contract = { verification_gates: [{ name: "types", command: "npx tsc --noEmit" }] };
		writeFileSync(itemsFile, JSON.stringify(doc));
	};
	write(f, "src/login.ts", "x\n");
	const pass = f.pass("A", T("10:00"), "# A passed: login \x1b]0;pwn\x07done\n- Diagnosis: Root cause here.\n");
	write(f, "src/login.ts", "y\n");
	const s = await readOnce(f);

	const parsed = detailBody(s, "A", 80, { raw: false, alerts: null }).map(plain);
	assert.match(parsed[0], /^✓ passed/);
	assert.ok(parsed.some((row) => /^✓ passed {2}login done/.test(row)), parsed.join("\n"));
	assert.ok(parsed.some((row) => /^Cause +Root cause here\.$/.test(row)));
	const commitsAt = parsed.indexOf("Commits");
	assert.match(parsed[commitsAt + 1], new RegExp(`^${pass.slice(0, 7)} pass feat: A`));
	assert.ok(parsed.slice(commitsAt).includes("  A src/login.ts"));
	assert.ok(parsed.includes("Steps"));
	assert.ok(parsed.includes("1 s"));
	assert.match(parsed.find((row) => row.startsWith("Gates"))!, /◌ stale: src\/login\.ts edited in worktree after [0-9a-f]{7}$/);
	assert.ok(parsed.includes("types  npx tsc --noEmit"));

	const raw = detailBody(s, "A", 80, { raw: true, alerts: null }).map(plain);
	assert.ok(raw.includes("# A passed: login done"), raw.join("\n"));
	assert.ok(raw.includes("- Diagnosis: Root cause here."));
	assert.ok(!raw.join("\n").includes("pwn"));
	assert.ok(!raw.join("\n").includes("\x1b"));

	// Enforcer findings per commit render from alerts when they exist (T12).
	const withAlert = detailBody(s, "A", 80, { raw: false, alerts: [{ timestamp: T("10:01"), level: "WARN", rule: "test-edit", item: "A", commit: pass, evidence: [], run: s.run }] }).map(plain);
	assert.ok(withAlert.includes("  ⚠ test-edit"));
	// Owner Q1 on #16: one proof state per item; a pending item has no accepted pass proof, so it is unknown.
	assert.match(plain(detailBody(s, "B", 80, { raw: false, alerts: null }).find((row) => plain(row).startsWith("Gates"))!), /^Gates +○ proof unknown$/);
});

// ---- Progress screen ----

test("progress screen: every entry newest first with its id, counts in the title, raw always available", async (t) => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	t.after(() => f.close());
	f.block("A", T("10:00"));
	f.pass("A", T("10:10"));
	f.progress += "# Free note \x1b[2Jwithout an item\n";
	f.writeBundle();
	f.commit("docs: note", T("10:20"));
	const s = await readOnce(f);
	assert.equal(plain(progressTitle(s, 40)), `Progress${" ".repeat(12)}1 passed · 1 blocked`);
	const parsed = progressBody(s, 80, false).map(plain);
	const heads = parsed.filter((row, i) => i === 0 || parsed[i - 1] === "");
	assert.deepEqual(heads.map((row) => row.trimEnd()), ["Free note without an item", "A ✓ passed  done", "A ✕ blocked  gate"]);
	const raw = progressBody(s, 80, true).map(plain);
	assert.deepEqual(raw.filter((row, i) => i === 0 || raw[i - 1] === ""), ["# Free note without an item", "# A passed: done", "# A blocked: gate"]);
	// A plain task or an empty progress file opens an empty body.
	assert.deepEqual(progressBody({ ...s, attempts: [] }, 80, false), []);
});
