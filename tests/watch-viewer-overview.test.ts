import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseProgress } from "../src/watch/progress.ts";
import type { Alert, LoopSnapshot, ObservedAttempt } from "../src/watch/types.ts";
import { attemptCard, badge, currentBody, enforcerChip, formatTokens, headerLine, progressBar, statusRows } from "../src/watch/viewer/overview.ts";
import { clock, Fixture, readOnce, T } from "./fixtures/loop-state.ts";

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

// ---- Review round 1 ----

test("80-column stopped loop with a three-digit budget keeps every status fact whole (review r1 P2)", async (t) => {
	const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1).padStart(2, "0"), title: `Item ${i + 1}`, passes: false }));
	const f = new Fixture(items);
	t.after(() => f.close());
	f.journal([
		{ v: 1, k: "run", r: "L1", t: T("09:59"), m: "m", th: "off", mx: 100, tk: "b" },
		{ v: 1, k: "loop", r: "L1", t: T("10:00"), tok: "run-a", sa: T("10:00"), i: 1, ph: "initialized" },
	]);
	// Seven passes 22 minutes apart: 10:22, 10:44, 11:06, 11:28, 11:50, 12:12, 12:34.
	const at = ["10:22", "10:44", "11:06", "11:28", "11:50", "12:12", "12:34"];
	for (let i = 0; i < 7; i++) f.pass(items[i].id, T(at[i]));
	f.state(false, T("10:00"), "run-a", { stop_reason: "max_iterations", completed_at: T("12:40"), iteration: 100, max_iterations: 100 });
	const s = await readOnce(f, clock(T("13:00")));
	// Badge column " ■ STOPPED max_iterations   " is 28 wide. Facts: median 22m x 5 left = 1h 50m, n=7;
	// 5 items left > 0 iterations left. "iteration 100/100  ⚠ 5 items left  ETA ~1h 50m n=7" is 50 wide: 28 + 50 = 78.
	const facts = "iteration 100/100  ⚠ 5 items left  ETA ~1h 50m n=7";
	assert.equal(plain(badge(s, Date.parse(T("13:00")))), "■ STOPPED max_iterations");
	assert.equal(plain(statusRows(s, 78, 2, NOW, null)[1]), `${" ".repeat(28)}${facts}`);
	// A warn chip (17 + 2 trailing): 1 + 50 + 2 + 19 <= 78, so the facts move left to 78 - 50 - 2 - 19 = 7.
	const warn: Alert = { timestamp: T("11:00"), level: "WARN", rule: "r", item: null, commit: null, evidence: [], run: s.run };
	assert.equal(plain(statusRows(s, 78, 2, NOW, null, enforcerChip([warn], 7))[1]), `${" ".repeat(7)}${facts}  ⚠ enforcer 1 warn  `);
	// A clean chip (26 + 2): 1 + 50 + 2 + 28 = 81 > 78, so it ends the bar row; the bar keeps 78 - 28 - 8 - 28 = 14
	// columns, 7/12 of 14 = 8 1/6 columns: 8 full and the nearest eighth (1/8, ▏), 5 track.
	const [first, second] = statusRows(s, 78, 2, NOW, null, enforcerChip([], 7)).map(plain);
	assert.equal(first, ` ■ STOPPED max_iterations   ${"█".repeat(8)}▏${"⣿".repeat(5)}  7/12  ✓ enforcer 7 commits clean  `);
	assert.equal(second, `${" ".repeat(28)}${facts}`);
});

/** Item A stays first false across three runs while the later item B passes in run b (review r1 P2). */
test("current-item run count ignores a pass of a later item and omits itself without complete history", async (t) => {
	const items = [{ id: "A", title: "First", passes: false }, { id: "B", title: "Second", passes: false }, { id: "C", title: "Third", passes: false }];
	const f = new Fixture(items);
	t.after(() => f.close());
	const loop = (tok: string, sa: string) => ({ v: 1 as const, k: "loop" as const, r: "L1", t: T(sa), tok, sa: T(sa), i: 1, ph: "initialized" as const });
	f.journal([{ v: 1, k: "run", r: "L1", t: T("09:59"), m: "m", th: "off", mx: 9, tk: "b" }, loop("run-a", "10:00"), loop("run-b", "10:20"), loop("run-c", "10:30")]);
	f.pass("B", T("10:25"));
	f.state(true, T("10:30"), "run-c", { owner_heartbeat_at: T("12:00") });
	const runs = (s: LoopSnapshot) => plain(currentBody(s, 60)[0]).split(" · ")[1];
	let s = await readOnce(f);
	assert.equal(s.currentItem, "A");
	// A has been current since run-a: run-a, run-b and run-c.
	assert.equal(runs(s), "3 runs");
	// A passes at 10:35 inside run-c: C becomes current then; only run-c counts.
	f.pass("A", T("10:35"));
	s = await readOnce(f);
	assert.equal(s.currentItem, "C");
	assert.equal(runs(s), "1 run");
	// Without the journal the run history is incomplete: no run count at all.
	const g = new Fixture(items);
	t.after(() => g.close());
	g.pass("B", T("10:25"));
	g.state(true, T("10:30"), "run-c", { owner_heartbeat_at: T("12:00") });
	const bare = await readOnce(g);
	assert.equal(bare.currentItem, "A");
	assert.ok(!/\brun/.test(plain(currentBody(bare, 60).join("\n"))), currentBody(bare, 60).join("\n"));
});

const card = (text: string): ObservedAttempt => ({ ...parseProgress(text)[0], commitSha: null, resolvedCommitSha: null });
const sgrOf = (row: string, glyphs: string) => new RegExp(`\\x1b\\[(\\d+)m${glyphs}\\x1b\\[0m`).exec(row)?.[1] ?? null;

test("attempt cards: proof squares green and red, check results coloured, untrusted text sanitized (review r1 P2)", () => {
	const mixed = card([
		"# K11 passed: types/common \x1b]52;c;SU5KRUNURUQ=\x07",
		"- Checks: `npm run typecheck` exit 0; `npm test` exit 1 then fixed",
		"```text", "IDENTICAL alpha", "DIFFERENT beta \x1b[31mred", "```", "",
	].join("\n"));
	assert.deepEqual(mixed.fields?.proof, { identical: 1, total: 2 });
	const rows = attemptCard(mixed, 70);
	const proof = rows.find((row) => plain(row).startsWith("Proof"))!;
	// Design spec sections 2 and 6: one green ■ per IDENTICAL line, one red ■ per different line.
	assert.equal(plain(proof).trimEnd(), "Proof    ■■ 1 differ");
	assert.equal(sgrOf(proof, "■"), "32");
	assert.ok(proof.includes("\x1b[31m■\x1b[0m"), JSON.stringify(proof));
	// The parser names the checks; typecheck ended 0 (green count 1), test ended 1 (red, named).
	assert.deepEqual(mixed.fields?.checks.map((c) => [c.cmd, c.exits.at(-1)]), [["typecheck", 0], ["test", 1]]);
	const checks = rows.find((row) => plain(row).startsWith("Checks"))!;
	// Card text wraps on single spaces (worker report: double spaces collapse).
	assert.equal(plain(checks).trimEnd(), "Checks   ✓ 1 ✕ test");
	assert.equal(sgrOf(checks, "✓"), "32");
	assert.equal(sgrOf(checks, "✕"), "31");
	const all = rows.join("\n");
	assert.ok(!all.includes("\x1b]52") && !all.includes("SU5KRUNURUQ=\x07"), "no OSC from untrusted text");

	const green = attemptCard(card("# K10 passed: parsers\n- Checks: `npm test` exit 0; `npm run lint` exit 0\n```text\nIDENTICAL a\nIDENTICAL b\n```\n"), 70);
	assert.equal(plain(green.find((row) => plain(row).startsWith("Proof"))!).trimEnd(), "Proof    ■■ 2/2 identical");
	assert.equal(plain(green.find((row) => plain(row).startsWith("Checks"))!).trimEnd(), "Checks   ✓ 2");
});

test("from 150 columns the token group stays with realistic long names; identity text is abbreviated (review r1 P2)", async (t) => {
	const f = designLoop(t);
	f.git("checkout", "-qb", "rw/typed-session-validation");
	f.state(true, T("10:00"), "run-a", { owner_heartbeat_at: T("12:00"), iteration: 4, max_iterations: 8, model_id: "claude-opus-4-5-20251101" });
	const s = await readOnce(f);
	const tokens = "Time 2h 00m · In 3.2M · Cached 41.6M · Out 215k · $18.61 ";
	// 150 columns, inner 148. Right part with hb: 65. Left: title (14) + 2 + worktree (30) + 2 + branch (29) = 77; 77 + 2 + 65 = 144 fits;
	// the model (+26) does not, so it drops.
	const at150 = plain(headerLine(s, "pi-ralph-loop-wt-typed-session", 148, 150));
	assert.match(at150, /^ ◆ Ralph Watch {2}pi-ralph-loop-wt-typed-session {2}⎇ rw\/typed-session-validation +hb 0s · Time 2h 00m · In 3\.2M · Cached 41\.6M · Out 215k · \$18\.61 $/);
	// A longer worktree name: the branch is abbreviated to what is left, tokens stay.
	const long = plain(headerLine(s, "pi-ralph-loop-wt-typed-session-validation-x", 148, 150));
	assert.ok(long.endsWith(`hb 0s · ${tokens}`), long);
	assert.match(long, /pi-ralph-loop-wt-typed-session-validation-x {2}⎇ rw\/typed-se\S*… /);
	assert.equal([...long].length, 148);
	// At 200 columns everything fits, including the model.
	assert.match(plain(headerLine(s, "pi-ralph-loop-wt-typed-session", 198, 200)), /⎇ rw\/typed-session-validation {2}claude-opus-4-5-20251101 +hb 0s · /);
});

test("token counts: integer kilo-tokens and one decimal for millions (approved prototype, review r1 P3)", () => {
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(1_500), "2k");
	assert.equal(formatTokens(9_400), "9k");
	assert.equal(formatTokens(215_000), "215k");
	assert.equal(formatTokens(3_200_000), "3.2M");
	assert.equal(formatTokens(41_600_000), "41.6M");
});
