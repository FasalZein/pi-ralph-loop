import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { defaultRuntime, openLoop, type ObservationRuntime } from "../src/watch/loop-state.ts";
import { clock, Fixture, midRead, readOnce, statuses, T, type Item } from "./fixtures/loop-state.ts";

// ---- Review regressions (rw-t3 review, findings 1-11) ----


test("review-1: a relaunch in ignored loop.md during the git window withholds activity", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const reader = openLoop(f.root, { runtime: midRead(() => f.state(true, T("10:20"), "run-b")) });
	try {
		f.block("A", T("10:05"));
		f.state(false, T("10:00"), "run-a");
		let s = await reader.read();
		assert.ok(s.issues.some((i) => i.source === "state" && i.kind === "concurrent"));
		assert.equal(s.state, null);
		assert.equal(s.sources.state.status, "unavailable");
		assert.deepEqual(statuses(s), { A: "pending" });
		s = await reader.read();
		assert.deepEqual([s.run.loopToken, statuses(s)], ["run-b", { A: "retry" }]);
	} finally { await reader.close(); f.close(); }
});

test("review-2a: a content change to an already-dirty items file during the read is detected", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	const reader = openLoop(f.root, { runtime: midRead(() => { f.items[0].passes = true; f.writeBundle(); }) });
	try {
		f.items[1].regression_notes = "dirty";
		f.writeBundle();
		f.state(true, T("10:00"));
		let s = await reader.read();
		assert.equal(s.git, null);
		assert.ok(s.issues.some((i) => i.source === "git" && i.kind === "concurrent"));
		assert.ok(!s.items.some((i) => i.status === "working"));
		s = await reader.read();
		assert.deepEqual(statuses(s), { A: "passed", B: "working" });
	} finally { await reader.close(); f.close(); }
});

test("review-2b: worktree fingerprint covers file content, including names with spaces and newlines", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const odd = path.join(f.root, "odd name\n\tx.txt");
	writeFileSync(odd, "one\n");
	f.commit("odd file", T("09:30"));
	writeFileSync(odd, "two\n");
	const reader = openLoop(f.root, { runtime: midRead(() => writeFileSync(odd, "six\n")) });
	try {
		f.state(true, T("10:00"));
		const s = await reader.read();
		assert.equal(s.git, null);
		assert.ok(s.issues.some((i) => i.source === "git" && i.kind === "concurrent"));
		assert.equal((await reader.read()).git?.head, f.git("rev-parse", "HEAD"));
	} finally { await reader.close(); f.close(); }
});

test("review-3: a transient historical items read failure is an issue and is not cached", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	try {
		f.block("A", T("10:05"));
		const passB = f.pass("B", T("10:10"));
		f.state(false, T("10:00"));
		let failed = false;
		const runtime: ObservationRuntime = {
			...clock(),
			git(root, args, signal) {
				const line = args.join(" ");
				if (!failed && line.includes(passB) && line.includes("items.json")) { failed = true; return Promise.reject(new Error("transient")); }
				return defaultRuntime.git(root, args, signal);
			},
		};
		const reader = openLoop(f.root, { runtime });
		try {
			let s = await reader.read();
			assert.ok(failed);
			assert.equal(s.git?.commits ?? null, null);
			assert.ok(s.issues.some((i) => i.source === "git" && /transient/.test(i.detail)));
			assert.notEqual(statuses(s).A, "blocked");
			s = await reader.read();
			assert.deepEqual(statuses(s), { A: "stopped", B: "passed" });
		} finally { await reader.close(); }
	} finally { f.close(); }
});

test("review-4: a failing required git stamp command is an issue and withholds git", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.block("A", T("10:05"));
		f.state(false, T("10:00"));
		const s = await readOnce(f, {
			...clock(),
			git: (root, args, signal) => (["status", "ls-files"].includes(args[0]) ? Promise.reject(new Error("stamp failed")) : defaultRuntime.git(root, args, signal)),
		});
		assert.equal(s.git, null);
		assert.ok(s.issues.some((i) => i.source === "git" && /stamp failed/.test(i.detail)));
		assert.deepEqual(statuses(s), { A: "stopped" });
	} finally { f.close(); }
});

test("review-5: a same-length edit of an old progress entry is detected and reparsed", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const reader = openLoop(f.root, { runtime: clock() });
	try {
		f.state(true, T("10:00"));
		const file = path.join(f.root, ".ralph/progress.md");
		const tail = "# B blocked: later entry that keeps the last sixty-four bytes unchanged\n";
		writeFileSync(file, "# A blocked: original\n" + tail);
		await reader.read();
		writeFileSync(file, "# A passed:  original\n" + tail);
		utimesSync(file, new Date(T("11:00")), new Date(T("11:00")));
		const s = await reader.read();
		assert.equal(s.attempts[0].outcome, "passed");
		assert.ok(s.issues.some((i) => i.source === "progress" && /edited, not appended/.test(i.detail)));
	} finally { await reader.close(); f.close(); }
});

test("review-6: an operational ancestry failure is unavailable, not proven non-ancestry", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.state(true, T("10:00"));
		const s = await readOnce(f, {
			...clock(),
			git: (root, args, signal) => (args[0] === "merge-base" ? Promise.reject(new Error("spawn failed")) : defaultRuntime.git(root, args, signal)),
		});
		assert.ok(!s.issues.some((i) => /not an ancestor/.test(i.detail)));
		assert.ok(s.issues.some((i) => i.source === "git" && i.kind === "unavailable" && /spawn failed/.test(i.detail)));
		assert.equal(s.git?.commits, null);
	} finally { f.close(); }
});

test("review-7: a pass entry committed before its flip commit gets no SHA and an issue", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.progress += "# A passed: done\n";
		f.writeBundle();
		f.commit("notes only", T("10:05"));
		f.items[0].passes = true;
		f.writeBundle();
		const flip = f.commit("feat: A", T("10:10"));
		f.state(false, T("10:00"));
		const s = await readOnce(f);
		assert.equal(s.git?.commits?.at(-1)?.sha, flip);
		assert.equal(s.attempts[0].commitSha, null);
		assert.ok(s.issues.some((i) => i.source === "progress" && /not introduced/.test(i.detail)));
	} finally { f.close(); }
});

test("review-8: invalid optional id or title metadata is an issue, not a fallback key", async () => {
	const f = new Fixture([{ id: "A", passes: false }], { mission: false });
	const reader = openLoop(f.root, { runtime: clock() });
	try {
		f.state(true, T("10:00"));
		assert.deepEqual(statuses(await reader.read()), { A: "working" });
		for (const bad of [{ id: 5 }, { title: 12 }, { id: " " }]) {
			f.items = [{ id: "A", passes: false, ...bad } as unknown as Item];
			f.writeBundle();
			const s = await reader.read();
			assert.deepEqual(s.items, [], JSON.stringify(bad));
			assert.ok(s.issues.some((i) => i.source === "items" && /must be a nonblank string/.test(i.detail)));
		}
	} finally { await reader.close(); f.close(); }
});

test("review-9: an item key __proto__ is an own, frozen itemAttempts entry", async () => {
	const f = new Fixture([{ id: "__proto__", passes: false }], { mission: false });
	try {
		f.progress = "# __proto__ blocked: gate\n";
		f.writeBundle();
		f.state(true, T("10:00"));
		const s = await readOnce(f);
		assert.deepEqual(Object.keys(s.itemAttempts), ["__proto__"]);
		const own = Object.getOwnPropertyDescriptor(s.itemAttempts, "__proto__")?.value as unknown[];
		assert.equal(own.length, 1);
		assert.ok(Object.isFrozen(own));
		assert.match(JSON.stringify(s.itemAttempts), /"__proto__":\[/);
	} finally { f.close(); }
});

test("review-10: after a good read, failed sources show retained values marked retained, never fresh", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	let appendDuringRead = false;
	// Appends after the progress read (during the git history window).
	const runtime = midRead(() => { if (appendDuringRead) appendFileSync(path.join(f.root, ".ralph/progress.md"), "# A blocked: racing\n"); });
	const reader = openLoop(f.root, { runtime: { ...runtime, git: (r, a, sig) => (a[0] === "rev-list" && !appendDuringRead ? defaultRuntime.git(r, a, sig) : runtime.git(r, a, sig)) } });
	try {
		f.block("A", T("10:05"));
		f.state(true, T("10:00"));
		const good = await reader.read();
		const fresh = { status: "fresh", error: null };
		assert.deepEqual(good.sources, { state: fresh, items: fresh, progress: fresh, git: fresh, history: fresh, journal: { status: "unavailable", error: ".ralph/journal.jsonl not found" } });
		assert.equal(good.retained.items, null);
		writeFileSync(path.join(f.root, ".ralph/items.json"), "{");
		writeFileSync(path.join(f.root, ".ralph/loop.md"), "---\nrunning: true\n");
		appendFileSync(path.join(f.root, ".ralph/progress.md"), "# A blocked: new\n");
		appendDuringRead = true;
		const s = await reader.read();
		assert.equal(s.sources.items.status, "retained");
		assert.equal(s.sources.state.status, "retained");
		assert.equal(s.sources.progress.status, "retained");
		assert.match(s.sources.progress.error ?? "", /changed during/);
		assert.deepEqual(s.items, []);
		assert.equal(s.state, null);
		assert.deepEqual(s.attempts, []);
		assert.equal(s.currentItem, null);
		assert.deepEqual(s.retained.items?.value.map((i) => [i.key, i.status]), [["A", "retry"]]);
		assert.equal(s.retained.items?.observedAt, good.observedAt);
		assert.equal(s.retained.state?.value.loop_token, "run-a");
		assert.equal(s.retained.attempts?.value.length, 1);
	} finally { await reader.close(); f.close(); }
});

test("review-11: an invalid committer timestamp is an issue and never a boundary time", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		const tree = f.git("rev-parse", "HEAD^{tree}");
		const head = f.git("rev-parse", "HEAD");
		const raw = path.join(f.root, "..", `${path.basename(f.root)}-commit.txt`);
		writeFileSync(raw, `tree ${tree}\nparent ${head}\nauthor T <t@example.invalid> 1790000000 +0000\ncommitter bad\n\nblocked(A): gate\n`);
		const oid = f.git("hash-object", "-t", "commit", "-w", "--literally", raw);
		rmSync(raw);
		f.git("update-ref", "HEAD", oid);
		f.state(false, T("10:00"));
		const s = await readOnce(f);
		const event = s.git?.commits?.at(-1);
		assert.equal(event?.sha, oid);
		assert.equal(event?.committedAt, null);
		assert.ok(s.issues.some((i) => i.source === "git" && i.detail === `invalid committer timestamp at ${oid}`));
		assert.deepEqual(statuses(s), { A: "stopped" });
	} finally { f.close(); }
});

// ---- Re-review regressions (R1-R8): one result shape per source ----

test("R1: an invalid historical items file after a blocker withholds blocked", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }, { id: "C", passes: false, title: "c" }]);
	try {
		f.block("A", T("10:05"));
		f.items = f.items.map((i) => (i.id === "B" ? { ...i, passes: true } : i.id === "C" ? { ...i, title: 12 as unknown as string } : i));
		f.writeBundle();
		f.commit("feat: B with a bad C title", T("10:10"));
		f.items[2].title = "c";
		f.writeBundle();
		f.commit("fix: C title", T("10:12"));
		f.state(false, T("10:00"));
		const s = await readOnce(f);
		assert.deepEqual(statuses(s), { A: "stopped", B: "passed", C: "pending" });
		assert.equal(s.sources.history.status, "fresh");
		assert.ok(s.issues.some((i) => i.source === "git" && /pass evidence unknown/.test(i.detail)));
	} finally { f.close(); }
});

test("R2: a pass entry only moved to a new index by the flip commit gets no SHA", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.progress = "# X blocked: other\n# A passed: done\n";
		f.writeBundle();
		f.commit("notes", T("10:05"));
		f.progress = "# A passed: done\n# X blocked: other\n";
		f.items[0].passes = true;
		f.writeBundle();
		f.commit("feat: A", T("10:10"));
		f.state(false, T("10:00"));
		const s = await readOnce(f);
		assert.equal(s.attempts[0].id, "A");
		assert.equal(s.attempts[0].commitSha, null);
		assert.ok(s.issues.some((i) => i.source === "progress" && /not introduced/.test(i.detail)));
	} finally { f.close(); }
});

test("R3: a history failure keeps git fresh, marks history retained and keeps last-good history", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	let fail = false;
	const runtime: ObservationRuntime = {
		...clock(),
		git: (root, args, signal) => (fail && args[0] === "cat-file" ? Promise.reject(new Error("blob read failed")) : defaultRuntime.git(root, args, signal)),
	};
	const reader = openLoop(f.root, { runtime });
	try {
		f.block("A", T("10:05"));
		f.state(false, T("10:00"));
		const good = await reader.read();
		const before = good.git?.commits?.length;
		f.block("A", T("10:07"));
		fail = true;
		const s = await reader.read();
		assert.equal(s.retained.history?.value.length, before);
		assert.equal(s.sources.git.status, "fresh");
		assert.equal(s.sources.history.status, "retained");
		assert.match(s.sources.history.error ?? "", /blob read failed/);
		assert.equal(s.git?.commits, null);
		assert.equal(s.retained.history?.value.length, before);
		assert.equal(s.retained.history?.observedAt, good.observedAt);
		assert.deepEqual(statuses(s), { A: "stopped" });
		fail = false;
		assert.equal((await reader.read()).git?.commits?.length, (before ?? 0) + 1);
	} finally { await reader.close(); f.close(); }
});

test("R4: a progress read error is a retained progress source; items stay fresh", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	let deny = false;
	const runtime: ObservationRuntime = {
		...clock(),
		readRange: (file, start, end) => (deny && file.endsWith("progress.md") ? Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })) : defaultRuntime.readRange(file, start, end)),
	};
	const reader = openLoop(f.root, { runtime });
	try {
		f.block("A", T("10:05"));
		f.state(true, T("10:00"));
		const good = await reader.read();
		assert.deepEqual(statuses(good), { A: "retry" });
		appendFileSync(path.join(f.root, ".ralph/progress.md"), "# A blocked: again\n");
		deny = true;
		const s = await reader.read();
		assert.equal(s.currentItem, "A");
		assert.equal(s.retained.attempts?.value.length, 1);
		assert.equal(s.task, "bundle");
		assert.equal(s.sources.items.status, "fresh");
		assert.equal(s.sources.progress.status, "retained");
		assert.match(s.sources.progress.error ?? "", /EACCES/);
		assert.equal(s.retained.attempts?.value.length, 1);
		assert.deepEqual(s.attempts, []);
		assert.equal(s.currentItem, "A");
	} finally { await reader.close(); f.close(); }
});

test("R5: an incomplete trailing UTF-8 sequence is withheld, never shown as U+FFFD", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const reader = openLoop(f.root, { runtime: clock() });
	try {
		f.state(true, T("10:00"));
		await reader.read();
		const euro = Buffer.from("# A blocked: price €\n");
		const file = path.join(f.root, ".ralph/progress.md");
		appendFileSync(file, euro.subarray(0, euro.length - 3));
		let s = await reader.read();
		assert.equal(s.attempts.at(-1)?.title, "price");
		assert.ok(!s.attempts.at(-1)?.raw.includes("\uFFFD"));
		appendFileSync(file, euro.subarray(euro.length - 3));
		s = await reader.read();
		assert.equal(s.attempts.at(-1)?.title, "price €");
	} finally { await reader.close(); f.close(); }
});

test("R7: a failed second git inspection keeps its cause and is not reported as concurrent", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	let lsFiles = 0;
	const runtime: ObservationRuntime = {
		...clock(),
		// The stamp's dirty-file listing (`--modified`), not the worktree evidence listing of untracked files.
		git: (root, args, signal) => (args[0] === "ls-files" && args.includes("--modified") && ++lsFiles === 2 ? Promise.reject(new Error("post-stamp access failure")) : defaultRuntime.git(root, args, signal)),
	};
	try {
		f.state(true, T("10:00"));
		const s = await readOnce(f, runtime);
		assert.equal(s.git, null);
		assert.ok(!s.issues.some((i) => i.kind === "concurrent"));
		assert.ok(s.issues.some((i) => i.source === "git" && /post-stamp access failure/.test(i.detail)));
		assert.match(s.sources.git.error ?? "", /post-stamp access failure/);
	} finally { f.close(); }
});

test("R8: an unreadable dirty file is an inspection error, not a deletion", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const dir = path.join(f.root, "private");
	try {
		mkdirSync(dir);
		writeFileSync(path.join(dir, "dirty.txt"), "one\n");
		f.commit("private file", T("09:30"));
		f.block("A", T("10:05"));
		f.state(false, T("10:00"));
		writeFileSync(path.join(dir, "dirty.txt"), "two\n");
		const reader = openLoop(f.root, { runtime: clock() });
		try {
			assert.equal((await reader.read()).git?.head, f.git("rev-parse", "HEAD"));
			chmodSync(dir, 0o000);
			const s = await reader.read();
			assert.equal(s.git, null);
			assert.ok(s.issues.some((i) => i.source === "git" && /EACCES|permission/i.test(i.detail)));
			assert.equal(s.sources.git.status, "retained");
			assert.notEqual(statuses(s).A, "blocked");
		} finally { await reader.close(); }
	} finally { chmodSync(dir, 0o755); f.close(); }
});

// ---- Re-review 2 regression (N1): items.json presence changes ----

for (const running of [false, true]) {
	test(`N1: a pass restored after items.json was deleted is unknown, not a missed pass (${running ? "running" : "stopped"})`, async () => {
		const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
		try {
			f.block("A", T("10:05"));
			rmSync(path.join(f.root, ".ralph/items.json"));
			f.commit("drop items", T("10:07"));
			f.items[1].passes = true;
			f.writeBundle();
			f.commit("restore with B passed", T("10:10"));
			f.state(running, T("10:00"));
			const s = await readOnce(f);
			assert.deepEqual(statuses(s), { A: running ? "working" : "stopped", B: "passed" });
			assert.ok(s.issues.some((i) => i.source === "git" && /pass evidence unknown/.test(i.detail)));
			assert.equal(s.sources.history.status, "fresh");
		} finally { f.close(); }
	});
}
