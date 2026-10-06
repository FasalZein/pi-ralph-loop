import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { Alert, LoopSnapshot } from "../src/watch/types.ts";
import { badge, enforcerChip, headerLine, progressBar, statusRows } from "../src/watch/viewer/overview.ts";
import { Fixture, readOnce, T } from "./fixtures/loop-state.ts";

const NOW = Date.parse(T("12:00"));
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

/** Design fixture after captures ov-80x24 and ov-120x40: 12 items, 7 passed, current 08, iteration 4/8, usage $18.61. */
function designLoop(t: test.TestContext, running = true): Fixture {
	const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1).padStart(2, "0"), title: `Item ${i + 1}`, passes: false }));
	const f = new Fixture(items);
	t.after(() => f.close());
	f.journal([
		{ v: 1, k: "run", r: "L1", t: T("09:59"), m: "m", th: "off", mx: 8, tk: "b" },
		{ v: 1, k: "loop", r: "L1", t: T("10:00"), tok: "run-a", sa: T("10:00"), i: 1, ph: "initialized" },
		{ v: 1, k: "u", r: "L1", t: T("11:00"), tok: "run-a", i: 1, in: 3_200_000, out: 215_000, cr: 41_600_000, cw: 0, c: 18.61, n: 1, dc: 0, pr: 0 },
	]);
	// Seven items, each passed 10 minutes after the previous boundary: 10:10 ... 11:10.
	for (let i = 0; i < 7; i++) f.pass(items[i].id, T(`1${Math.floor((i + 1) / 6)}:${String(((i + 1) % 6) * 10).padStart(2, "0")}`));
	f.state(running, T("10:00"), "run-a", { owner_heartbeat_at: T("12:00"), iteration: 4, max_iterations: 8, model_id: "model-x" });
	return f;
}

test("progress bar: solid fill, nearest eighth edge, dim track (captures ov-80x24, ov-120x40, ov-200x50)", () => {
	// 7/12 of 57 = 33.25 columns: 33 full and 2/8 (▎). 7/12 of 97 = 56.58: 56 full and 5/8 (▋). 7/12 of 106 = 61.83: ▉.
	assert.equal(plain(progressBar(7, 12, 57)), `${"█".repeat(33)}▎${"⣿".repeat(23)}`);
	assert.equal(plain(progressBar(7, 12, 97)), `${"█".repeat(56)}▋${"⣿".repeat(40)}`);
	assert.equal(plain(progressBar(7, 12, 106)), `${"█".repeat(61)}▉${"⣿".repeat(44)}`);
	assert.equal(plain(progressBar(12, 12, 10)), "█".repeat(10));
	assert.equal(plain(progressBar(0, 12, 10)), "⣿".repeat(10));
	assert.equal(progressBar(1, 0, 10), "");
});

test("enforcer chip: hard over warn over clean with the commit count (design spec section 1)", () => {
	const alert = (level: Alert["level"]): Alert => ({ timestamp: T("11:00"), level, rule: "r", item: null, commit: null, evidence: [], run: { launchId: null, loopToken: null, startedAt: null } });
	assert.equal(plain(enforcerChip([], 9)), "✓ enforcer 9 commits clean");
	assert.equal(plain(enforcerChip([alert("INFO")], 1)), "✓ enforcer 1 commit clean");
	assert.equal(plain(enforcerChip([alert("WARN"), alert("INFO")], 9)), "⚠ enforcer 1 warn");
	assert.equal(plain(enforcerChip([alert("WARN"), alert("HARD"), alert("HARD")], 9)), "✕ enforcer 2 hard");
});

test("design fixture at 80 columns: header, both status rows with the budget warning, ETA and chip", async (t) => {
	const s = await readOnce(designLoop(t));
	// Inner width 78 (80 columns minus two frame borders).
	const header = plain(headerLine(s, "wt", 78, 80));
	assert.match(header, /^ ◆ Ralph Watch {2}wt {2}⎇ \S+ {2}model-x +hb 0s · Time 2h 00m · \$18\.61 $/);
	assert.ok(!header.includes("In "), "tokens only from 150 columns");
	const warn: Alert = { timestamp: T("11:00"), level: "WARN", rule: "r", item: null, commit: null, evidence: [], run: s.run };
	const rows = statusRows(s, 78, 2, NOW, null, enforcerChip([warn], 7)).map(plain);
	assert.equal(rows[0], ` ● RUNNING   ${"█".repeat(33)}▎${"⣿".repeat(23)}  7/12  `);
	// 5 items left > 8 - 4 iterations left: warning. Seven 10-minute durations: median 10m x 5 = 50m, n=7.
	assert.match(rows[1], /^ {13}iteration 4\/8 {2}⚠ 5 items left {2}ETA ~50m n=7 +⚠ enforcer 1 warn {2}$/);
	assert.equal(rows[1].length, 78);
});

test("design fixture at 150+ columns: one status row and tokens in the header", async (t) => {
	const s = await readOnce(designLoop(t));
	assert.match(plain(headerLine(s, "wt", 148, 150)), /hb 0s · Time 2h 00m · In 3\.2M · Cached 41\.6M · Out 215k · \$18\.61 $/);
	const [row] = statusRows(s, 198, 1, NOW, null).map(plain);
	assert.match(row, /^ ● RUNNING {3}█+[▏▎▍▌▋▊▉]?⣿+ {2}7\/12 {2}ETA ~50m n=7 {3}iteration 4\/8 {2}⚠ 5 items left {2}$/);
	assert.equal([...row].length, 198);
});

test("budget warning boundary: items left equal to iterations left is no warning", async (t) => {
	const f = designLoop(t);
	// 5 items left, 8 - 3 = 5 iterations left.
	f.state(true, T("10:00"), "run-a", { owner_heartbeat_at: T("12:00"), iteration: 3, max_iterations: 8 });
	const rows = statusRows(await readOnce(f), 78, 2, NOW, null).map(plain);
	assert.match(rows[1], /^ {13}iteration 3\/8 {2}5 items left {2}ETA/);
});

test("badge: NEEDS YOU only when the stopped item is blocked; otherwise STOPPED with its reason (owner Q3 on #15)", async (t) => {
	const f = designLoop(t, false);
	f.state(false, T("10:00"), "run-a", { stop_reason: "manual_stop", iteration: 4, max_iterations: 8 });
	assert.equal(plain(badge(await readOnce(f), NOW)), "■ STOPPED manual_stop");
	f.block("08", T("11:30"));
	assert.equal(plain(badge(await readOnce(f), NOW)), "■ NEEDS YOU");
});

test("robustness: malformed items, half-written state, missing progress and plain tasks render without a crash", async (t) => {
	const f = designLoop(t);
	const draw = (s: LoopSnapshot) => {
		for (const [w, cols, rows] of [[78, 80, 2], [148, 150, 1]] as const) {
			assert.ok(headerLine(s, "wt", w, cols).length > 0);
			for (const row of statusRows(s, w, rows, NOW, null)) assert.equal([...plain(row)].length <= w, true);
		}
		return statusRows(s, 78, 2, NOW, null).map(plain).join("\n");
	};
	writeFileSync(path.join(f.root, ".ralph/items.json"), "{ not json");
	draw(await readOnce(f));
	rmSync(path.join(f.root, ".ralph/progress.md"));
	draw(await readOnce(f));
	// Half-written state: the file is cut in the middle of its header.
	writeFileSync(path.join(f.root, ".ralph/loop.md"), "---\nrunning: tr");
	const text = draw(await readOnce(f));
	assert.ok(!text.includes("iteration"), "no iteration count without fresh state");
	assert.ok(!/legend|not stored|unavailable/i.test(text), text);
});
