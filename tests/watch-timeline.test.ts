import assert from "node:assert/strict";
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Fixture, T, clock, midRead, readOnce, statuses } from "./fixtures/loop-state.ts";
import { deriveTimeline } from "../src/watch/timeline.ts";
import { openLoop } from "../src/watch/loop-state.ts";
import type { JournalRecord } from "../src/watch/types.ts";

const iso = (time: string) => `2026-09-30T${time.length === 5 ? `${time}:00` : time}.000Z`;
const run = (r: string, t: string): JournalRecord => ({ v: 1, k: "run", r, t: iso(t), m: "m", th: "off", mx: 9, tk: "b" });
const loop = (r: string, t: string, tok: string, sa = t): Extract<JournalRecord, { k: "loop" }> => ({ v: 1, k: "loop", r, t: iso(t), tok, sa: iso(sa), i: 1, ph: "initialized" });
const gate = (r: string, t: string, tok: string): JournalRecord => ({ v: 1, k: "g", r, t: iso(t), tok, i: 1, p: "NEXT", ok: 1 });
function buildTimeline() {
	const f = new Fixture(["A", "B", "C", "D"].map((id) => ({ id, passes: false })));
	f.pass("A", T("10:30"));
	const p = f.commit("fix: parent", T("10:40"));
	f.block("B", T("10:50"));
	f.pass("C", T("12:20"));
	f.pass("B", T("13:25"));
	const missionPath = path.join(f.root, ".ralph/mission.json");
	const mission = JSON.parse(readFileSync(missionPath, "utf8"));
	mission.git.parentCommits = [{ sha: p, reason: "owner fix" }];
	writeFileSync(missionPath, JSON.stringify(mission));
	const records: JournalRecord[] = [run("L1", "10:00"), loop("L1", "10:00", "run-a"), gate("L1", "10:31", "run-a"),
		{ v: 1, k: "d", r: "L1", t: iso("11:00"), e: "exit", c: 0 },
		run("L2", "12:00"), loop("L2", "12:00", "run-b"), gate("L2", "12:21", "run-b"),
		{ v: 1, k: "d", r: "L2", t: iso("12:30"), e: "pi-exit", c: 1 },
		run("L3", "13:00"), { ...loop("L3", "13:10", "run-c", "12:00"), ph: "resumed", i: 2 }, gate("L3", "13:26", "run-c")];
	f.journal(records);
	f.state(true, T("12:00"), "run-c", { iteration: 2, owner_heartbeat_at: iso("13:39:30"), error_count: 1 });
	return { f, records };
}

test("hand-computed timeline matches exactly", async () => {
	const { f } = buildTimeline();
	try {
		const s = await readOnce(f, clock(T("13:40")));
		assert.deepEqual(statuses(s), { A: "passed", B: "passed", C: "passed", D: "working" });
		assert.equal(s.timeline.durations.A.ms, 1_800_000);
		assert.equal(s.timeline.durations.C.ms, 1_200_000);
		assert.equal(s.timeline.durations.B.ms, 1_500_000);
		assert.equal(s.timeline.currentItem?.ms, 900_000);
		assert.deepEqual(s.timeline.eta, { estimateMs: 1_500_000, n: 3, itemsLeft: 1 });
		assert.deepEqual(s.timeline.elapsed, { wallMs: 6_000_000, activeMs: 3_600_000 });
		assert.deepEqual(s.timeline.boundaries.map((b) => [new Date(b.at).toISOString(), b.kind]), [
			[iso("10:00"), "run-start"], [iso("10:30"), "item-pass"], [iso("10:40"), "parent"], [iso("10:50"), "blocker"],
			[iso("12:00"), "run-start"], [iso("12:00"), "run-start"], [iso("12:20"), "item-pass"], [iso("13:25"), "item-pass"],
		]);
		assert.deepEqual(s.timeline.stopped, [{ from: iso("11:00"), to: iso("12:00"), known: true }, { from: iso("12:30"), to: iso("13:10"), known: true }]);
		assert.deepEqual(s.runStarts.map((r) => [r.loopToken, r.startedAt, r.source]), [["run-a", iso("10:00"), "journal"], ["run-b", iso("12:00"), "journal"], ["run-c", iso("12:00"), "journal"]]);
		assert.equal(s.run.launchId, "L3");
		assert.equal(s.historyComplete, true);
		assert.equal(s.health.state, "running");
		assert.equal(s.health.stale, false);
		assert.equal(s.health.heartbeatAgeMs, 30_000);
		assert.equal(s.health.stalled, "unavailable");
		assert.equal(s.health.lastJournalAt, iso("13:26"));
	} finally { f.close(); }
});

test("coverage incomplete after rotation: A unavailable, eta 22.5 min n=2", async () => {
	const { f, records } = buildTimeline();
	try {
		f.journal(records.slice(4), "journal.1.jsonl"); f.journal([records[8]]);
		const s = await readOnce(f, clock(T("13:40")));
		assert.equal(s.timeline.coverage.start, T("12:00"));
		assert.equal(s.historyComplete, false); assert.match(s.timeline.coverage.reason!, /rotated/);
		assert.equal(s.timeline.durations.A.ms, null);
		assert.equal(s.timeline.durations.C.ms, 1_200_000); assert.equal(s.timeline.durations.B.ms, 1_500_000);
		assert.deepEqual(s.timeline.eta, { estimateMs: 1_350_000, n: 2, itemsLeft: 1 });
		assert.equal(s.timeline.currentItem?.ms, 900_000);
		// Retained journal is display-only; read a second time after deletion to inspect launches below.
		const reader = openLoop(f.root, { runtime: clock(T("13:40")) });
		try { await reader.read(); unlinkSync(path.join(f.root, ".ralph/journal.jsonl")); unlinkSync(path.join(f.root, ".ralph/journal.1.jsonl"));
			assert.deepEqual((await reader.read()).retained.journal?.value.launches.map((l) => l.launchId), ["L2", "L3"]);
		} finally { await reader.close(); }
	} finally { f.close(); }
});

test("unknown stop makes the spanning duration unavailable", async () => {
	const { f, records } = buildTimeline();
	try {
		f.journal(records.filter((_, i) => i !== 7));
		const s = await readOnce(f, clock(T("13:40")));
		assert.equal(s.timeline.durations.B.ms, null); assert.match(s.timeline.durations.B.ms === null ? s.timeline.durations.B.reason : "", /unknown stop/);
		assert.deepEqual(s.timeline.eta, { estimateMs: 1_500_000, n: 2, itemsLeft: 1 });
		assert.match(s.timeline.coverage.reason!, /unknown stop/);
		assert.deepEqual(s.timeline.stopped[1], { from: T("12:21"), to: T("13:10"), known: false });
	} finally { f.close(); }
});

test("eta is n/a with n=0 until one item is measured", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	const reader = openLoop(f.root, { runtime: clock(T("12:00")) });
	try {
		f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a")]); f.state(true, T("10:00"));
		assert.deepEqual((await reader.read()).timeline.eta, { estimateMs: null, n: 0, itemsLeft: 2 });
		f.pass("A", T("10:30"));
		assert.deepEqual((await reader.read()).timeline.eta, { estimateMs: 1_800_000, n: 1, itemsLeft: 1 });
	} finally { await reader.close(); f.close(); }
});

for (const kind of ["item-pass", "blocker", "parent", "run-start"] as const) test(`time on item uses the latest ${kind} boundary`, async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	try {
		f.state(true, T("10:00")); f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a")]);
		if (kind === "item-pass") f.pass("A", T("11:00"));
		if (kind === "blocker") f.block("A", T("11:00"));
		if (kind === "parent") {
			const sha = f.commit("parent", T("11:00")); const p = path.join(f.root, ".ralph/mission.json");
			const m = JSON.parse(readFileSync(p, "utf8")); m.git.parentCommits = [{ sha, reason: "owner fix" }]; writeFileSync(p, JSON.stringify(m));
		}
		if (kind === "run-start") { f.state(true, T("11:00"), "run-b"); f.appendJournalRaw(JSON.stringify(loop("L1", "11:00", "run-b")) + "\n"); }
		const s = await readOnce(f);
		assert.equal(s.timeline.currentItem?.ms, 3_600_000);
		assert.equal(s.timeline.currentItem && "since" in s.timeline.currentItem ? s.timeline.currentItem.since.kind : null, kind);
		assert.deepEqual(Object.keys(s.timeline.durations), kind === "item-pass" ? ["A"] : []);
		assert.equal(s.timeline.eta.n, kind === "item-pass" ? 1 : 0);
	} finally { f.close(); }
});

test("stopped time is excluded from duration and time on item", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	try {
		f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a"), { v: 1, k: "d", r: "L1", t: T("10:10"), e: "exit" },
			run("L2", "10:30"), loop("L2", "10:40", "run-b", "10:00")]);
		f.state(true, T("10:00"), "run-b");
		assert.equal((await readOnce(f, clock(T("11:00")))).timeline.currentItem?.ms, 1_800_000);
		f.pass("A", T("11:00"));
		assert.equal((await readOnce(f)).timeline.durations.A.ms, 1_800_000);
	} finally { f.close(); }
});

test("a commit that flips two items gives unavailable for both", async () => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	try {
		f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a")]); f.state(true, T("10:00"));
		f.items.forEach((i) => { i.passes = true; }); f.writeBundle(); f.commit("two passes", T("10:30"));
		const s = await readOnce(f); assert.equal(s.timeline.durations.A.ms, null); assert.equal(s.timeline.durations.B.ms, null);
		assert.ok(s.issues.some((i) => i.source === "timeline" && /multiple items/.test(i.detail)));
	} finally { f.close(); }
});

test("commit time earlier than previous boundary gives unavailable and an issue", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a")]); f.state(true, T("10:00"));
		f.block("A", T("11:00")); f.pass("A", T("10:30"));
		const s = await readOnce(f); assert.equal(s.timeline.durations.A.ms, null);
		assert.ok(s.issues.some((i) => i.source === "timeline" && /earlier/.test(i.detail)));
	} finally { f.close(); }
});

test("merge in range makes the duration unavailable", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a")]); f.state(true, T("10:00"));
		const main = f.git("branch", "--show-current"); f.git("checkout", "-qb", "side");
		writeFileSync(path.join(f.root, "side"), "x"); f.commit("side", T("10:10")); f.git("checkout", "-q", main);
		writeFileSync(path.join(f.root, "main"), "x"); f.commit("main", T("10:15"));
		f.env = { GIT_COMMITTER_DATE: T("10:20"), GIT_AUTHOR_DATE: T("10:20") }; f.git("merge", "--no-ff", "-qm", "merge", "side");
		f.pass("A", T("10:30")); const s = await readOnce(f);
		assert.equal(s.timeline.durations.A.ms, null); assert.ok(s.issues.some((i) => i.source === "timeline" && /nonlinear/.test(i.detail)));
	} finally { f.close(); }
});

test("plain task has no durations and eta n/a", async () => {
	const f = new Fixture([], { plain: true });
	try { f.state(true, T("10:00"), "run-a", { bundle_mode: false });
		const s = await readOnce(f); assert.deepEqual(Object.keys(s.timeline.durations), []); assert.deepEqual(s.timeline.eta, { estimateMs: null, n: 0, itemsLeft: 0 });
	} finally { f.close(); }
});

test("journal partial trailing line and split UTF-8 are carried until completion", async () => {
	const f = new Fixture([{ id: "A", passes: false }]); const reader = openLoop(f.root, { runtime: clock() });
	try {
		f.state(true, T("10:00")); f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a")]);
		const bytes = Buffer.from(JSON.stringify({ v: 1, k: "x", r: "L1", t: T("11:00"), op: "steer", id: null, ok: 1, txt: "café" }) + "\n");
		const split = bytes.indexOf(Buffer.from("é")) + 1;
		f.appendJournalRaw(bytes.subarray(0, split));
		const partial = await reader.read(); assert.equal(partial.sources.journal.status, "fresh"); assert.equal(partial.historyComplete, true); assert.equal(partial.health.lastJournalAt, T("10:00"));
		f.appendJournalRaw(bytes.subarray(split)); const complete = await reader.read(); assert.equal(complete.health.lastJournalAt, T("11:00")); assert.equal(complete.historyComplete, true);
		unlinkSync(path.join(f.root, ".ralph/journal.jsonl"));
		const retained = (await reader.read()).retained.journal?.value;
		assert.equal(retained?.badLines, 0); assert.equal(retained?.records.at(-1)?.k, "x");
		assert.equal(retained?.records.flatMap((r) => r.k === "x" ? [r.txt] : []).at(-1), "café");
	} finally { await reader.close(); f.close(); }
});

test("journal incremental parsing reads the appended range; unchanged poll reads zero bytes", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	const reads: [number, number | undefined][] = []; const base = clock();
	const reader = openLoop(f.root, { runtime: { ...base, async readRange(file, start, end) { if (file.endsWith("journal.jsonl")) reads.push([start, end]); return base.readRange(file, start, end); } } });
	try {
		f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a")]); f.state(true, T("10:00"));
		const oldSize = statSync(path.join(f.root, ".ralph/journal.jsonl")).size;
		await reader.read(); reads.length = 0; await reader.read(); assert.deepEqual(reads, []);
		f.appendJournalRaw(JSON.stringify(gate("L1", "11:00", "run-a")) + "\n"); await reader.read();
		const size = statSync(path.join(f.root, ".ralph/journal.jsonl")).size;
		// Prefix validation detects a same-inode rewrite plus append. Parsing still uses only new bytes.
		assert.deepEqual(reads, [[0, oldSize], [oldSize, size]]);
	} finally { await reader.close(); f.close(); }
});

test("journal rotation between polls is followed without duplicate launches", async () => {
	const f = new Fixture([{ id: "A", passes: false }]); const reader = openLoop(f.root, { runtime: clock() });
	try {
		const header = run("L1", "10:00"); f.journal([header, loop("L1", "10:00", "run-a")]); f.state(true, T("10:00"));
		await reader.read(); f.appendJournalRaw(JSON.stringify(gate("L1", "10:30", "run-a")) + "\n");
		renameSync(path.join(f.root, ".ralph/journal.jsonl"), path.join(f.root, ".ralph/journal.1.jsonl")); f.journal([header, gate("L1", "11:00", "run-a")]);
		const s = await reader.read(); assert.equal(s.sources.journal.status, "fresh"); assert.equal(s.historyComplete, false); assert.equal(s.health.lastJournalAt, T("11:00"));
		unlinkSync(path.join(f.root, ".ralph/journal.jsonl")); unlinkSync(path.join(f.root, ".ralph/journal.1.jsonl"));
		const retained = (await reader.read()).retained.journal?.value;
		assert.equal(retained?.launches.length, 1); assert.deepEqual(retained?.records.map((r) => r.k), ["run", "loop", "g", "g"]);
	} finally { await reader.close(); f.close(); }
});

test("journal truncation and same-inode prefix rewrite plus append reparse with an issue", async () => {
	const f = new Fixture([{ id: "A", passes: false }]); const reader = openLoop(f.root, { runtime: clock() });
	try {
		f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a"), gate("L1", "11:00", "run-a")]); f.state(true, T("10:00")); await reader.read();
		f.journal([run("L1", "10:00")]); const truncated = await reader.read(); assert.ok(truncated.issues.some((i) => i.source === "journal" && /truncated/.test(i.detail)));
		f.journal([run("L2", "10:00"), loop("L2", "10:00", "run-a")]); const rewritten = await reader.read(); assert.ok(rewritten.issues.some((i) => i.source === "journal" && /rewritten/.test(i.detail)));
	} finally { await reader.close(); f.close(); }
});

test("journal missing gives unavailable source and no timing, never invented", async () => {
	const { f } = buildTimeline(); const reader = openLoop(f.root, { runtime: clock(T("13:40")) });
	try {
		assert.equal((await reader.read()).historyComplete, true); unlinkSync(path.join(f.root, ".ralph/journal.jsonl"));
		const s = await reader.read(); assert.equal(s.sources.journal.status, "retained"); assert.equal(s.historyComplete, false);
		assert.equal(s.timeline.durations.A.ms, null); assert.equal(s.timeline.currentItem?.ms, null); assert.equal(s.timeline.elapsed?.activeMs, null); assert.equal(s.timeline.eta.n, 0);
		assert.equal(s.health.lastJournalAt, null);
		const freshReader = await readOnce(f); assert.equal(freshReader.sources.journal.status, "unavailable"); assert.match(freshReader.sources.journal.error!, /not found/);
	} finally { await reader.close(); f.close(); }
});

test("bad journal line gives partial issue and historyComplete false", async () => {
	const { f } = buildTimeline();
	try { f.appendJournalRaw("not-json\n" + JSON.stringify({ ...run("L3", "13:30"), t: "invalid" }) + "\n");
		const s = await readOnce(f, clock(T("13:40"))); assert.equal(s.sources.journal.status, "fresh"); assert.equal(s.historyComplete, false);
		assert.ok(s.issues.some((i) => i.source === "journal" && /2 invalid/.test(i.detail))); assert.equal(s.timeline.durations.B.ms, null);
	} finally { f.close(); }
});

for (const rotation of [false, true]) test(`journal ${rotation ? "rotation" : "append"} during read ${rotation ? "is" : "is not"} concurrent`, async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		const header = run("L1", "10:00"); f.journal([header, loop("L1", "10:00", "run-a")]); f.state(true, T("10:00"));
		const runtime = midRead(() => {
			if (rotation) { renameSync(path.join(f.root, ".ralph/journal.jsonl"), path.join(f.root, ".ralph/journal.1.jsonl")); f.journal([header]); }
			else f.appendJournalRaw(JSON.stringify(gate("L1", "11:00", "run-a")) + "\n");
		});
		const s = await readOnce(f, runtime); assert.equal(s.sources.journal.status, rotation ? "unavailable" : "fresh");
		assert.equal(s.issues.some((i) => i.source === "journal" && i.kind === "concurrent"), rotation); assert.equal(s.sources.git.status, "fresh");
	} finally { f.close(); }
});

test("untracked journal appends do not make git concurrent", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		writeFileSync(path.join(f.root, ".gitignore"), ".ralph/loop.md\n");
		f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a")]); f.state(true, T("10:00"));
		assert.ok(f.git("ls-files", "--others", "--exclude-standard").includes("journal.jsonl"));
		const s = await readOnce(f, midRead(() => f.appendJournalRaw(JSON.stringify(gate("L1", "11:00", "run-a")) + "\n")));
		assert.equal(s.sources.git.status, "fresh"); assert.equal(s.sources.history.status, "fresh");
	} finally { f.close(); }
});

test("launch identity prefers loop record for state token, then a launch newer than state start", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a"), run("L2", "11:00")]); f.state(true, T("10:00"));
		assert.equal((await readOnce(f)).run.launchId, "L1"); f.state(true, T("10:00"), "new-token"); assert.equal((await readOnce(f)).run.launchId, "L2");
		f.state(true, T("11:00"), "new-token"); assert.equal((await readOnce(f)).run.launchId, null);
		f.state(true, T("11:30"), "new-token"); assert.equal((await readOnce(f)).run.launchId, null);
	} finally { f.close(); }
});

test("eta uses median, not arithmetic mean, for skewed measured durations", async () => {
	const f = new Fixture(["A", "B", "C", "D"].map((id) => ({ id, passes: false })));
	try {
		f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a")]); f.state(true, T("10:00"));
		f.pass("A", T("10:10")); f.pass("B", T("10:30")); f.pass("C", T("12:00"));
		const s = await readOnce(f, clock(T("12:30")));
		assert.equal(s.timeline.durations.A.ms, 600_000); assert.equal(s.timeline.durations.B.ms, 1_200_000); assert.equal(s.timeline.durations.C.ms, 5_400_000);
		assert.deepEqual(s.timeline.eta, { estimateMs: 1_200_000, n: 3, itemsLeft: 1 });
	} finally { f.close(); }
});

test("current stopped interval ends only on a later loop record; duplicate stop facts count once", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try {
		f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a"), { v: 1, k: "d", r: "L1", t: T("10:31"), e: "pi-exit" }, { v: 1, k: "d", r: "L1", t: T("10:32"), e: "exit" }]);
		f.state(false, T("10:00"), "run-a", { completed_at: T("10:30"), stop_reason: "manual_stop" });
		const s = await readOnce(f); assert.deepEqual(s.timeline.stopped, [{ from: T("10:30"), to: null, known: true }]);
		assert.equal(s.timeline.currentItem?.ms, 1_800_000); assert.deepEqual(s.timeline.elapsed, { wallMs: 7_200_000, activeMs: 1_800_000 });
	} finally { f.close(); }
});

test("journal gap withholds spanning timing and complete history", async () => {
	const { f } = buildTimeline();
	try { f.appendJournalRaw(JSON.stringify({ v: 1, k: "d", r: "L3", t: T("13:20"), e: "gap" }) + "\n");
		const s = await readOnce(f, clock(T("13:40"))); assert.equal(s.historyComplete, false); assert.match(s.timeline.coverage.reason!, /gap/);
		assert.equal(s.timeline.durations.B.ms, null); assert.equal(s.timeline.durations.A.ms, 1_800_000); assert.equal(s.timeline.currentItem?.ms, 900_000);
	} finally { f.close(); }
});

test("rotation finalizes a partial old tail as bad, while a lost rotation reparses", async () => {
	const f = new Fixture([{ id: "A", passes: false }]); const reader = openLoop(f.root, { runtime: clock() });
	try {
		const header = run("L1", "10:00"); f.journal([header, loop("L1", "10:00", "run-a")]); f.state(true, T("10:00"));
		f.appendJournalRaw("{\"half\":"); await reader.read();
		renameSync(path.join(f.root, ".ralph/journal.jsonl"), path.join(f.root, ".ralph/journal.1.jsonl")); f.journal([header]);
		const rotated = await reader.read(); assert.ok(rotated.issues.some((i) => i.source === "journal" && /1 invalid/.test(i.detail)));
		unlinkSync(path.join(f.root, ".ralph/journal.1.jsonl")); renameSync(path.join(f.root, ".ralph/journal.jsonl"), path.join(f.root, "old-journal")); f.journal([run("L2", "11:00")]);
		const lost = await reader.read(); assert.ok(lost.issues.some((i) => i.source === "journal" && /rotation not followed/.test(i.detail))); assert.equal(lost.health.lastJournalAt, T("11:00"));
	} finally { await reader.close(); f.close(); }
});

test("short journal read gives retained display evidence and retries without caching failure", async () => {
	const f = new Fixture([{ id: "A", passes: false }]); const base = clock(); let short = false;
	const reader = openLoop(f.root, { runtime: { ...base, async readRange(file, start, end) { const bytes = await base.readRange(file, start, end); return short && file.endsWith("journal.jsonl") && start > 0 ? bytes.subarray(0, 0) : bytes; } } });
	try {
		f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a")]); f.state(true, T("10:00")); await reader.read();
		f.appendJournalRaw(JSON.stringify(gate("L1", "11:00", "run-a")) + "\n"); short = true;
		const s = await reader.read(); assert.equal(s.sources.journal.status, "retained"); assert.match(s.sources.journal.error!, /short journal read/); assert.equal(s.timeline.currentItem?.ms, null);
		short = false; const recovered = await reader.read(); assert.equal(recovered.sources.journal.status, "fresh"); assert.equal(recovered.health.lastJournalAt, T("11:00"));
	} finally { await reader.close(); f.close(); }
});

test("equal-time boundaries are not previous boundaries for item duration", async () => {
	const f = new Fixture([{ id: "A", passes: false }]);
	try { f.journal([run("L1", "10:00"), loop("L1", "10:00", "run-a")]); f.state(true, T("10:00")); f.pass("A", T("10:00"));
		const s = await readOnce(f); assert.equal(s.timeline.durations.A.ms, null); assert.equal(s.timeline.eta.n, 0);
	} finally { f.close(); }
});

for (const [patch, expected] of [[{ committedAt: null }, /commit time unavailable/], [{ passesKnown: false }, /pass evidence unknown/]] as const) test(`pure timing rejects ${expected.source}`, () => {
	const header = run("L1", "10:00"), started = loop("L1", "10:00", "run-a");
	const runs = [{ source: "journal" as const, loopToken: "run-a", startedAt: T("10:00") }];
	const { timeline, issues } = deriveTimeline({
		commits: [{ sha: "pass", parents: ["base"], subject: "pass", committedAt: T("10:30"), kind: "item-pass", passedItems: ["A"], blockerItem: null, parentReason: null, passesKnown: true, ...patch }],
		runs, journal: { records: [header, started], launches: [{ launchId: "L1", at: T("10:00") }], runs, stops: [], badLines: 0, rotated: false, coverageStart: T("10:00") },
		state: null, items: [{ key: "A", index: 0, id: "A", title: "A", description: "do A", passes: true, regressionNotes: "", status: "passed" }], item: null, now: T("12:00"),
	});
	assert.equal(timeline.durations.A.ms, null); assert.equal(timeline.eta.n, 0); assert.ok(issues.some((i) => expected.test(i.detail)));
});

test("iteration history shows gates and interventions, correlates only unambiguous commits", async () => {
	const { f, records } = buildTimeline();
	try {
		f.journal([...records, { v: 1, k: "x", r: "L3", t: iso("13:27"), op: "stop", id: "stop", ok: 1 },
			{ v: 1, k: "g", r: "L3", t: iso("13:28"), tok: "run-c", i: 2, p: "WAIT", ok: 0, why: "proof missing" }]);
		const s = await readOnce(f, clock(T("13:40")));
		const gates = s.iterations?.filter((e) => e.kind === "gate");
		assert.equal(gates?.[0].commit, s.git?.commits?.find((c) => c.passedItems.includes("A"))?.sha);
		assert.equal(gates?.[0].item, "A");
		assert.equal(gates?.at(-1)?.commit, null);
		assert.deepEqual(gates?.at(-1)?.marks, ["rejection"]);
		assert.ok(s.iterations?.some((e) => e.kind === "intervention" && e.op === "stop"));
		assert.ok(s.iterations?.some((e) => e.kind === "parent" && e.reason === "owner fix"));
	} finally { f.close(); }
});

test("iteration gates retain NEXT, STOP, COMPLETE and WAIT; only rejections and enforcer findings have marks", async () => {
	const { deriveIterations } = await import("../src/watch/timeline.ts");
	const { readJournal } = await import("../src/watch/journal.ts");
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", passes: false }]);
	try {
		const pass = f.pass("A", T("10:30"));
		const decision = (time: string, p: "NEXT" | "STOP" | "COMPLETE" | "WAIT", ok: 0 | 1 = 1): JournalRecord => ({ v: 1, k: "g", r: "L1", t: iso(time), tok: "run-a", i: 1, p, ok });
		const records: JournalRecord[] = [run("L1", "10:00"), loop("L1", "10:00", "run-a"),
			gate("L1", "10:31", "run-a"),
			decision("10:32", "WAIT", 0),
			decision("10:33", "STOP"),
			decision("10:34", "COMPLETE")];
		f.journal(records); f.state(true, T("10:00"));
		const snapshot = await readOnce(f);
		const journal = { ...readJournal(f.root), launches: [{ launchId: "L1", at: T("10:00") }], runs: snapshot.runStarts, stops: [], coverageStart: T("10:00") };
		const entries = deriveIterations({ journal, commits: snapshot.git!.commits, items: snapshot.items, alerts: [
			{ timestamp: T("10:30"), level: "WARN", rule: "scope", commit: pass, item: "A", evidence: ["file"], run: snapshot.run },
		] });
		const gates = entries?.filter((e) => e.kind === "gate");
		assert.deepEqual(gates?.map((e) => e.promise), ["NEXT", "WAIT", "STOP", "COMPLETE"]);
		assert.deepEqual(gates?.map((e) => e.marks), [["enforcer"], ["rejection"], [], []]);
		assert.deepEqual(gates?.map((e) => e.item), ["A", "B", "B", "B"]);
		const incomplete = deriveIterations({ journal: { ...journal, rotated: true }, commits: snapshot.git!.commits, alerts: [] });
		assert.equal(incomplete?.[0].kind, "incomplete");
		assert.ok(incomplete?.filter((e) => e.kind === "gate").every((e) => e.commit === null));
		const ambiguous = deriveIterations({ journal, commits: [...snapshot.git!.commits!, { ...snapshot.git!.commits!.at(-1)!, sha: "another" }], alerts: [] });
		assert.equal(ambiguous?.find((e) => e.kind === "gate")?.commit, null);
	} finally { f.close(); }
});
