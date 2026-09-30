import assert from "node:assert/strict";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultRuntime, openLoop, type ObservationRuntime } from "../src/watch/loop-state.ts";
import { clock, Fixture, readOnce, statuses, T, type Item } from "./fixtures/loop-state.ts";

// ---- Item derivation rules ----

test("current-first-false-running: list order picks current; a later pass does not advance it", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }, { id: "C", passes: false }]);
	try {
		f.pass("B", T("10:10"));
		f.state(true, T("10:00"));
		const s = await readOnce(f);
		assert.equal(s.currentItem, "A");
		assert.equal(s.stoppedItem, null);
		assert.deepEqual(statuses(s), { A: "working", B: "passed", C: "pending" });
	} finally { f.close(); }
});

test("passed-wins: a passed item stays passed despite a newer blocker and notes", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	try {
		f.pass("A", T("10:05"));
		f.items[0].regression_notes = "regressed once";
		f.block("A", T("10:10"));
		f.state(false, T("10:00"));
		assert.deepEqual(statuses(await readOnce(f)), { A: "passed", B: "stopped" });
	} finally { f.close(); }
});

test("current-working: running first false without a blocker is working; others pending", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	try {
		f.state(true, T("10:00"));
		const s = await readOnce(f);
		assert.deepEqual(statuses(s), { A: "working", B: "pending" }, JSON.stringify(s.issues));
	} finally { f.close(); }
});

test("current-retry-after-blocker: a blocker from before the relaunch still explains retry", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.block("A", T("10:05"));
		f.state(true, T("10:20"), "run-b");
		const s = await readOnce(f);
		assert.equal(s.currentItem, "A");
		assert.deepEqual(statuses(s), { A: "retry" });
	} finally { f.close(); }
});

test("stopped-new-blocker: blocked needs a blocker strictly newer than the run start", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	try {
		f.block("A", T("10:05"));
		f.state(false, T("10:00"));
		const s = await readOnce(f);
		assert.equal(s.stoppedItem, "A");
		assert.equal(s.currentItem, null);
		assert.deepEqual(statuses(s), { A: "blocked", B: "pending" });
		// Equality is not newer.
		f.state(false, T("10:05"));
		assert.deepEqual(statuses(await readOnce(f)), { A: "stopped", B: "pending" });
	} finally { f.close(); }
});

test("stopped-no-new-blocker: an old blocker before the latest start gives stopped", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	try {
		f.block("A", T("10:05"));
		f.state(false, T("10:20"), "run-b");
		assert.deepEqual(statuses(await readOnce(f)), { A: "stopped", B: "pending" });
	} finally { f.close(); }
});

test("notes-not-blocked: regression notes alone never give blocked", async () => {
	const f = new Fixture([{ id: "A", passes: false, regression_notes: "failed twice: gate red" }]);
	try {
		f.state(false, T("10:00"));
		const s = await readOnce(f);
		assert.equal(s.items[0].regressionNotes, "failed twice: gate red");
		assert.deepEqual(statuses(s), { A: "stopped" });
	} finally { f.close(); }
});

test("unknown-runtime-not-stopped: missing or partial state proves neither stopped nor working", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: true }]);
	try {
		f.block("A", T("10:05"));
		let s = await readOnce(f);
		assert.deepEqual(statuses(s), { A: "pending", B: "passed" });
		assert.equal(s.currentItem, null);
		assert.equal(s.stoppedItem, null);
		assert.ok(s.issues.some((i) => i.source === "state" && i.kind === "missing"));
		writeFileSync(path.join(f.root, ".ralph/loop.md"), "---\nrunning: false\niteration: 1\n");
		s = await readOnce(f);
		assert.deepEqual(statuses(s), { A: "pending", B: "passed" });
		assert.equal(s.state, null);
		assert.ok(s.issues.some((i) => i.source === "state" && i.kind === "partial"));
	} finally { f.close(); }
});

test("all-passed-no-current: no current or stopped item when all items pass", async () => {
	const f = new Fixture([{ id: "A", passes: true }]);
	try {
		f.state(true, T("10:00"));
		const s = await readOnce(f);
		assert.equal(s.currentItem, null);
		assert.equal(s.stoppedItem, null);
	} finally { f.close(); }
});

test("plain-task-empty-items: a plain task has no items or cards", async () => {
	const f = new Fixture([{ id: "A", passes: false }], { plain: true });
	try {
		f.state(true, T("10:00"), "run-a", { bundle_mode: false });
		const s = await readOnce(f);
		assert.equal(s.task, "plain");
		assert.deepEqual(s.items, []);
		assert.deepEqual(s.attempts, []);
		assert.equal(s.currentItem, null);
	} finally { f.close(); }
});

test("timeline: blocked, then retry after relaunch, then working after another pass", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	try {
		f.block("A", T("10:05"));
		f.state(false, T("10:00"), "run-a");
		assert.deepEqual(statuses(await readOnce(f)), { A: "blocked", B: "pending" });
		f.state(true, T("10:20"), "run-b");
		assert.deepEqual(statuses(await readOnce(f)), { A: "retry", B: "pending" });
		f.pass("B", T("10:25"));
		const s = await readOnce(f);
		assert.deepEqual(statuses(s), { A: "working", B: "passed" });
		assert.deepEqual(s.git?.commits?.map((c) => [c.kind, c.subject, c.committedAt?.slice(11, 16)]).slice(1), [
			["blocker", "blocked(A): gate", "10:05"], ["item-pass", "feat: B", "10:25"],
		]);
	} finally { f.close(); }
});

test("an unknown captured blocker item binds to no item", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.block("Z", T("10:05"));
		f.state(false, T("10:00"));
		const s = await readOnce(f);
		assert.equal(s.git?.commits?.at(-1)?.kind, "other");
		assert.deepEqual(statuses(s), { A: "stopped" });
	} finally { f.close(); }
});

// ---- Run boundaries ----

test("recorded-start-boundary: a valid loop.md start is the recorded run start", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.state(true, T("10:00"));
		const s = await readOnce(f);
		assert.deepEqual(s.runStarts, [{ source: "state", loopToken: "run-a", startedAt: T("10:00") }]);
		assert.deepEqual(s.run, { launchId: null, loopToken: "run-a", startedAt: T("10:00") });
	} finally { f.close(); }
});

test("observed-relaunch-new-run and same-run-no-duplicate-start", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const reader = openLoop(f.root, { runtime: clock() });
	try {
		f.state(true, T("10:00"));
		await reader.read();
		f.state(true, T("10:00"), "run-a", { iteration: 2 });
		assert.equal((await reader.read()).runStarts.length, 1);
		f.state(true, T("10:20"), "run-b");
		assert.deepEqual((await reader.read()).runStarts.map((r) => [r.loopToken, r.startedAt]), [["run-a", T("10:00")], ["run-b", T("10:20")]]);
	} finally { await reader.close(); f.close(); }
});

test("invalid-start-no-boundary: an unparseable started_at gives an issue, not a boundary", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.state(true, "yesterday");
		const s = await readOnce(f);
		assert.deepEqual(s.runStarts, []);
		assert.ok(s.issues.some((i) => i.source === "state" && /started_at/.test(i.detail)));
	} finally { f.close(); }
});

test("fresh-reader-history-incomplete: a new reader knows only the recorded start", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.state(false, T("10:00"), "run-a");
		f.state(true, T("10:20"), "run-b", { iteration: 1 });
		const s = await readOnce(f);
		assert.deepEqual(s.runStarts.map((r) => r.loopToken), ["run-b"]);
		assert.equal(s.historyComplete, false);
	} finally { f.close(); }
});

// ---- Progress cards ----

test("failed-row-with-zero-checks: a blocked card keeps its Failed row with no checks", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.block("A", T("10:05"));
		f.state(false, T("10:00"));
		const card = (await readOnce(f)).itemAttempts.A[0];
		assert.deepEqual(card.fields?.failed, { cmd: "test", exit: 1, error: null });
		assert.deepEqual(card.fields?.checks, []);
	} finally { f.close(); }
});

test("resolved-index-not-sha and resolved-card-real-pass-sha", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.block("A", T("10:05"));
		const passSha = f.pass("A", T("10:10"));
		f.state(false, T("10:00"));
		const s = await readOnce(f);
		assert.equal(s.attempts[0].resolvedBy, 1);
		assert.equal(s.attempts[0].resolvedCommitSha, passSha);
		assert.equal(s.attempts[1].commitSha, passSha);
		assert.deepEqual(s.itemAttempts.A.map((a) => a.index), [1, 0]);
	} finally { f.close(); }
});

test("uncommitted-resolution-no-sha: an uncommitted pass entry has no commit", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	try {
		f.block("A", T("10:05"));
		appendFileSync(path.join(f.root, ".ralph/progress.md"), "# A passed: done\n# C blocked: unknown item\n");
		f.state(true, T("10:00"));
		const s = await readOnce(f);
		assert.equal(s.attempts[0].resolvedBy, 1);
		assert.equal(s.attempts[0].resolvedCommitSha, null);
		assert.equal(s.attempts[1].commitSha, null);
		// Unknown cards stay in global history but bind to no item.
		assert.equal(s.attempts[2].id, "C");
		assert.deepEqual(Object.keys(s.itemAttempts).sort(), ["A", "B"]);
		assert.deepEqual(s.itemAttempts.A.map((a) => a.index), [1, 0]);
	} finally { f.close(); }
});

test("unresolved blocked cards sort before newer cards for their item", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.block("A", T("10:05"), "# A blocked: first\n");
		f.progress += "# A unknown note\n# X passed: other\n";
		f.block("A", T("10:06"), "# A blocked: second\n");
		f.state(false, T("10:00"));
		const s = await readOnce(f);
		assert.deepEqual(s.itemAttempts.A.map((a) => a.title), ["second", "first"]);
	} finally { f.close(); }
});

// ---- Robustness ----

test("half-written state gives an issue and no terminal status", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		writeFileSync(path.join(f.root, ".ralph/loop.md"), '---\nrunning: false\niteration: 1\nstarted_at: "x"\nloop_token: ""\n---\n');
		const s = await readOnce(f);
		assert.equal(s.state, null);
		assert.ok(s.issues.some((i) => i.source === "state" && i.detail === "empty field: loop_token"));
		assert.deepEqual(statuses(s), { A: "pending" });
	} finally { f.close(); }
});

test("malformed items on first read give an issue and recover on the next read", async () => {
	const f = new Fixture([{ id: "A", passes: false }], { mission: false });
	const reader = openLoop(f.root, { runtime: clock() });
	try {
		f.state(true, T("10:00"));
		writeFileSync(path.join(f.root, ".ralph/items.json"), '{"version": 1, "items": [');
		let s = await reader.read();
		assert.deepEqual(s.items, []);
		assert.ok(s.issues.some((i) => i.source === "items" && i.kind === "partial"));
		f.writeBundle();
		s = await reader.read();
		assert.deepEqual(statuses(s), { A: "working" });
	} finally { await reader.close(); f.close(); }
});

test("duplicate item ids are an issue, not guessed items", async () => {
	const f = new Fixture([{ id: "A", passes: false }], { mission: false });
	try {
		f.items = [{ id: "A", passes: false }, { id: "A", passes: true }];
		f.writeBundle();
		f.state(true, T("10:00"));
		const s = await readOnce(f);
		assert.deepEqual(s.items, []);
		assert.ok(s.issues.some((i) => i.detail === "duplicate bundle item key"));
	} finally { f.close(); }
});

test("a torn items file on first read with a mission gives an issue, then loads", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const reader = openLoop(f.root, { runtime: clock() });
	try {
		f.state(true, T("10:00"));
		writeFileSync(path.join(f.root, ".ralph/items.json"), "{");
		let s = await reader.read();
		assert.equal(s.mission, null);
		assert.ok(s.issues.some((i) => i.source === "mission" && i.kind === "partial"));
		f.writeBundle();
		s = await reader.read();
		assert.notEqual(s.mission, null);
		assert.deepEqual(statuses(s), { A: "working" });
	} finally { await reader.close(); f.close(); }
});

test("missing progress is an issue; item status stays independent", async () => {
	const f = new Fixture([{ id: "A", passes: true }, { id: "B", passes: false }]);
	try {
		rmSync(path.join(f.root, ".ralph/progress.md"));
		f.state(true, T("10:00"));
		const s = await readOnce(f);
		assert.ok(s.issues.some((i) => i.source === "progress" && i.kind === "missing"));
		assert.deepEqual(statuses(s), { A: "passed", B: "working" });
	} finally { f.close(); }
});

test("a git error is an issue; blocked is not proven", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.block("A", T("10:05"));
		f.state(false, T("10:00"));
		const s = await readOnce(f, { ...clock(), git: async () => { throw new Error("git exploded"); } });
		assert.equal(s.git, null);
		assert.ok(s.issues.some((i) => i.source === "git" && /git exploded/.test(i.detail)));
		assert.deepEqual(statuses(s), { A: "stopped" });
	} finally { f.close(); }
});

test("observed loop without mission: items and HEAD, no base history", async () => {
	const f = new Fixture([{ id: "A", passes: false }], { mission: false });
	try {
		f.state(true, T("10:00"));
		const s = await readOnce(f);
		assert.equal(s.mission, null);
		assert.equal(s.task, "bundle");
		assert.equal(s.git?.head, f.git("rev-parse", "HEAD"));
		assert.equal(s.git?.commits, null);
		assert.ok(s.issues.some((i) => i.source === "mission" && i.kind === "missing"));
		assert.deepEqual(statuses(s), { A: "working" });
	} finally { f.close(); }
});

test("mid-read HEAD change gives a concurrent issue, then a coherent next read", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	let injected = false;
	const runtime: ObservationRuntime = {
		...clock(),
		async git(root, args, signal) {
			const out = await defaultRuntime.git(root, args, signal);
			if (!injected && args[0] === "rev-list") { injected = true; f.pass("A", T("10:30")); }
			return out;
		},
	};
	const reader = openLoop(f.root, { runtime });
	try {
		f.block("A", T("10:05"));
		f.state(false, T("10:00"));
		let s = await reader.read();
		assert.equal(s.git, null);
		assert.ok(s.issues.some((i) => i.source === "git" && i.kind === "concurrent"));
		s = await reader.read();
		assert.equal(s.git?.head, f.git("rev-parse", "HEAD"));
		assert.ok(!s.issues.some((i) => i.kind === "concurrent"));
		assert.deepEqual(statuses(s), { A: "passed" });
	} finally { await reader.close(); f.close(); }
});

test("large progress reads: unchanged polls read nothing; a changed file is read once and its prefix verified", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const ranges: [string, number, number | undefined][] = [];
	const shows: string[] = [];
	const runtime: ObservationRuntime = {
		...clock(),
		readRange(file, start, end) { ranges.push([path.basename(file), start, end]); return defaultRuntime.readRange(file, start, end); },
		git(root, args, signal) { if (args[0] === "show") shows.push(args.join(" ")); return defaultRuntime.git(root, args, signal); },
	};
	const reader = openLoop(f.root, { runtime });
	try {
		f.progress = "# Z passed: filler\n" + "- note line\n".repeat(50_000);
		f.writeBundle();
		f.commit("progress", T("10:01"));
		f.state(true, T("10:00"));
		await reader.read();
		const size = Buffer.byteLength(f.progress);
		assert.deepEqual(ranges.filter((r) => r[0] === "progress.md"), [["progress.md", 0, size]]);
		const firstShows = shows.length;
		ranges.length = 0;
		await reader.read();
		assert.deepEqual(ranges.filter((r) => r[0] === "progress.md"), []);
		// Immutable commits are inspected once per SHA.
		assert.equal(shows.length, firstShows);
		// A split multibyte character across appends still decodes.
		const euro = Buffer.from("# A blocked: price €\n");
		appendFileSync(path.join(f.root, ".ralph/progress.md"), euro.subarray(0, euro.length - 3));
		await reader.read();
		appendFileSync(path.join(f.root, ".ralph/progress.md"), euro.subarray(euro.length - 3));
		const s = await reader.read();
		// Each changed poll reads the file once; the old prefix is hash-verified, not trusted.
		// One full read per change, shared by the worktree fingerprint and the parser (owner rule).
		assert.deepEqual(ranges.filter((r) => r[0] === "progress.md"), [
			["progress.md", 0, size + euro.length - 3], ["progress.md", 0, size + euro.length],
		]);
		// An unchanged dirty file is not reread by the source or the fingerprint.
		ranges.length = 0;
		await reader.read();
		assert.deepEqual(ranges.filter((r) => r[0] === "progress.md"), []);
		assert.ok(!s.issues.some((i) => i.source === "progress"));
		assert.equal(s.attempts.at(-1)?.title, "price €");
	} finally { await reader.close(); f.close(); }
});

test("truncated or replaced progress is reparsed from the start", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const reader = openLoop(f.root, { runtime: clock() });
	try {
		f.state(true, T("10:00"));
		appendFileSync(path.join(f.root, ".ralph/progress.md"), "# A blocked: one\n# A blocked: two\n");
		assert.equal((await reader.read()).attempts.length, 2);
		writeFileSync(path.join(f.root, ".ralph/progress.md"), "# A passed: x\n");
		assert.deepEqual((await reader.read()).attempts.map((a) => a.outcome), ["passed"]);
	} finally { await reader.close(); f.close(); }
});

test("snapshots are deeply frozen; overlapping reads serialize; close is idempotent", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const reader = openLoop(f.root, { runtime: clock() });
	try {
		f.state(true, T("10:00"));
		const [a, b] = await Promise.all([reader.read(), reader.read()]);
		assert.deepEqual(statuses(a), statuses(b));
		assert.ok(Object.isFrozen(a) && Object.isFrozen(a.items[0]) && Object.isFrozen(a.issues));
		assert.throws(() => { (a.items as ObservedItemArray).push(a.items[0]); });
		assert.equal(a.observedAt, T("12:00"));
		const controller = new AbortController();
		controller.abort();
		const aborted = await reader.read(controller.signal);
		assert.ok(aborted.issues.some((i) => i.detail === "read aborted"));
		assert.deepEqual(statuses(await reader.read()), { A: "working" });
		await reader.close();
		await reader.close();
		const closed = await reader.read();
		assert.ok(closed.issues.some((i) => i.detail === "reader closed"));
	} finally { await reader.close(); f.close(); }
});
type ObservedItemArray = unknown[];

test("a same-inode edit before the old end is detected and reparsed", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const reader = openLoop(f.root, { runtime: clock() });
	try {
		f.state(true, T("10:00"));
		const file = path.join(f.root, ".ralph/progress.md");
		writeFileSync(file, "# A blocked: one\n");
		await reader.read();
		// Rewrite in place (same inode) and grow: not an append.
		writeFileSync(file, "# A passed: won\n# A blocked: two\n");
		const s = await reader.read();
		assert.deepEqual(s.attempts.map((a) => [a.outcome, a.title]), [["passed", "won"], ["blocked", "two"]]);
		assert.ok(s.issues.some((i) => i.source === "progress" && /edited, not appended/.test(i.detail)));
	} finally { await reader.close(); f.close(); }
});

test("a merge in history gives a partial issue and no blocked assertion", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.git("checkout", "-qb", "side");
		f.commit("side work", T("10:02"));
		f.git("checkout", "-q", "-");
		f.block("A", T("10:05"));
		f.env = { GIT_COMMITTER_DATE: T("10:06"), GIT_AUTHOR_DATE: T("10:06") };
		f.git("merge", "-q", "--no-ff", "-m", "blocked(A): merge", "side");
		f.state(false, T("10:00"));
		const s = await readOnce(f);
		const merge = s.git?.commits?.at(-1);
		assert.equal(merge?.parents.length, 2);
		assert.equal(merge?.kind, "other");
		assert.ok(s.issues.some((i) => i.source === "git" && /merge/.test(i.detail)));
		assert.deepEqual(statuses(s), { A: "stopped" });
	} finally { f.close(); }
});

test("detached HEAD reports no branch; a rewind drops unreachable commits", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const reader = openLoop(f.root, { runtime: clock() });
	try {
		const setup = f.git("rev-parse", "HEAD");
		f.block("A", T("10:05"));
		f.state(false, T("10:00"));
		assert.deepEqual(statuses(await reader.read()), { A: "blocked" });
		f.git("checkout", "-q", "--detach", setup);
		const s = await reader.read();
		assert.equal(s.git?.branch, null);
		assert.equal(s.git?.head, setup);
		assert.deepEqual(s.git?.commits?.map((c) => c.subject), ["setup"]);
		assert.deepEqual(statuses(s), { A: "stopped" });
	} finally { await reader.close(); f.close(); }
});

test("staging a change during a read gives a concurrent issue", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	let injected = false;
	const runtime: ObservationRuntime = {
		...clock(),
		async git(root, args, signal) {
			const out = await defaultRuntime.git(root, args, signal);
			if (!injected && args[0] === "rev-list") {
				injected = true;
				writeFileSync(path.join(f.root, "new file.txt"), "x");
				f.git("add", "new file.txt");
			}
			return out;
		},
	};
	try {
		f.state(true, T("10:00"));
		const s = await readOnce(f, runtime);
		assert.equal(s.git, null);
		assert.ok(s.issues.some((i) => i.kind === "concurrent"));
		assert.deepEqual(statuses(s), { A: "working" });
	} finally { f.close(); }
});

test("independent readers keep independent run-start history", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const first = openLoop(f.root, { runtime: clock() });
	try {
		f.state(true, T("10:00"), "run-a");
		await first.read();
		f.state(true, T("10:20"), "run-b");
		assert.equal((await first.read()).runStarts.length, 2);
		assert.deepEqual((await readOnce(f)).runStarts.map((r) => r.loopToken), ["run-b"]);
	} finally { await first.close(); f.close(); }
});

test("openLoop rejects a missing root and a mismatched mission", async () => {
	assert.throws(() => openLoop(path.join(tmpdir(), "no-such-ralph-root-xyz")));
	const f = new Fixture([{ id: "A", passes: false }]);
	const g = new Fixture([{ id: "A", passes: false }]);
	try {
		const { loadMission } = await import("../src/watch/config.ts");
		const mission = await loadMission(g.root);
		assert.throws(() => openLoop(f.root, { mission }), /mission root/);
	} finally { f.close(); g.close(); }
});

