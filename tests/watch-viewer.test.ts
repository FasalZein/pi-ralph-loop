import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { getKeybindings } from "@earendil-works/pi-tui";

import { openLoop } from "../src/watch/loop-state.ts";
import { emptyTotals } from "../src/watch/rpc.ts";
import type { EventFrame, LoopReader, LoopSnapshot } from "../src/watch/types.ts";
import { runViewer, type ViewerRuntime } from "../src/watch/viewer.ts";
import { allocate } from "../src/watch/viewer/layout.ts";
import { clock, Fixture, T } from "./fixtures/loop-state.ts";
import { ReplayTerminal } from "./fixtures/replay-terminal.ts";

const NOW = T("12:00");

/** A running bundle loop with one passed item; the second item title carries hostile terminal bytes. */
function runningLoop(t: test.TestContext): Fixture {
	const f = new Fixture([
		{ id: "A", title: "Parse config", passes: false },
		{ id: "B", title: "Evil \x1b]0;pwned\x07title\x1b[31m", passes: false },
	]);
	t.after(() => f.close());
	f.pass("A", T("10:10"));
	f.state(true, T("10:00"), "run-a", { owner_heartbeat_at: NOW });
	return f;
}

type Harness = {
	term: ReplayTerminal;
	done: Promise<void>;
	resolved: () => boolean;
	tick: () => void;
	interval: () => number | null;
	advance: (ms: number) => void;
	reads: () => number;
	closed: () => boolean;
};

function start(root: string, term: ReplayTerminal, wrap: (reader: LoopReader) => LoopReader = (r) => r, more: Partial<ViewerRuntime> | ViewerRuntime["connectEvents"] = {}): Harness {
	const extra: Partial<ViewerRuntime> = typeof more === "function" ? { connectEvents: more } : more;
	let now = Date.parse(NOW);
	let tickFn: (() => void) | null = null;
	let intervalMs: number | null = null;
	let reads = 0;
	let closed = false;
	const runtime: ViewerRuntime = {
		terminal: term,
		now: () => now,
		setInterval: (fn, ms) => { tickFn = fn; intervalMs = ms; return 1; },
		clearInterval: () => { tickFn = null; },
		openLoop: (r) => {
			const inner = wrap(openLoop(r, { runtime: clock(NOW) }));
			return {
				read: (signal) => { reads++; return inner.read(signal); },
				close: async () => { closed = true; await inner.close(); },
			};
		},
		...extra,
	};
	let resolved = false;
	const done = runViewer({ roots: [root] }, runtime).then(() => { resolved = true; });
	return {
		term, done, resolved: () => resolved,
		tick: () => tickFn?.(),
		interval: () => intervalMs,
		advance: (ms) => { now += ms; },
		reads: () => reads,
		closed: () => closed,
	};
}

async function until(predicate: () => boolean, what: string, ms = 3_000): Promise<void> {
	const end = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const quitByKeys = async (h: Harness) => {
	h.term.send("Q");
	await until(() => h.term.text().includes("Quit Ralph Watch?"), "quit prompt");
	h.term.send("y");
	await h.done;
};

// ---- Layout helpers ----

test("allocate fills fixed rows, gives the rest to the flexible row and truncates from the bottom", () => {
	assert.deepEqual(allocate(24, [1, 2, "rest", 1]), [1, 2, 20, 1]);
	assert.deepEqual(allocate(3, [1, 2, "rest", 1]), [1, 2, 0, 0]);
	assert.deepEqual(allocate(0, [1, "rest"]), [0, 0]);
});

// ---- Frame ----

test("desktop frame at 80x24: one outer rounded frame, shared dividers with junctions, exact rows", async (t) => {
	const f = runningLoop(t);
	const h = start(f.root, new ReplayTerminal(80, 24));
	await until(() => h.term.text().includes("RUNNING"), "first frame");
	const s = h.term.screen();
	assert.equal(s.length, 24);
	for (const row of s) assert.equal([...row].length, 80);
	// Rows (design spec section 3, two status rows below 150 columns): top, header, divider, status x2,
	// split divider, main, closing divider, footer, bottom.
	assert.match(s[0], /^╭─+╮$/);
	// Started 10:00, observed 12:00, heartbeat now; no journal, so no cost.
	assert.match(s[1], /^│ ◆ Ralph Watch {2}ralph-loop-state-\S+ {2}⎇ \S+ +hb 0s · event · Time 2h 00m │$/);
	assert.match(s[2], /^├─+┤$/);
	// Bar: 78 inner - " ● RUNNING   " (13) - "  1/2  " (7) = 58 columns; 1/2 passed fills 29.
	assert.equal(s[3], `│ ● RUNNING   ${"█".repeat(29)}${"⣿".repeat(29)}  1/2  │`);
	// Without a journal the timing coverage is incomplete, so no duration is measured: ETA n/a (spec #1 story 20).
	// One item left, 8 iterations left: no warning.
	assert.match(s[4], /^│ {13}iteration 1\/9 {2}1 item left {2}ETA n\/a +│$/);
	// Owner Q2 on #15: list column clamp(34, 60, round(0.38 * 80)) = 34; current item 80 - 3 - 34 = 43, junction at 44.
	assert.equal(s[5].indexOf("┬"), 44);
	assert.match(s[5], /^├─+┬─+┤$/);
	for (let row = 6; row <= 18; row++) {
		assert.equal(s[row][0], "│");
		assert.equal(s[row][44], "│");
		assert.equal(s[row][79], "│");
	}
	assert.equal(s[19].indexOf("┴"), 44);
	assert.match(s[20], /^│ activity unavailable.*│$/);
	assert.match(s[21], /^├─+┤$/);
	// Overview footer: only keys that work there (design spec section 7, #16).
	assert.match(s[22], /^│ ↑↓ Items  ⏎ Detail  p Progress  a Activity  ⇧Q Quit +│$/);
	assert.match(s[23], /^╰─+╯$/);
	assert.match(s[6], /^│ ● Current item B {2}Evil +title +│ Items +1\/2 │$/);
	// Category "c". Run count and time on item need complete history (journal coverage), so both are omitted.
	assert.match(s[7], /^│ c +│ ✓ A Parse config +│$/);
	assert.match(s[8], /^│ +│ ● B Evil +title +│$/);
	assert.match(s[9], /^│ Steps +│ +│$/);
	assert.match(s[10], /^│ 1 s +│ +│$/);
	await quitByKeys(h);
});

test("desktop frame at 200x50: status in one row and three columns Items 46, middle 86, side 64", async (t) => {
	const f = runningLoop(t);
	const h = start(f.root, new ReplayTerminal(200, 50));
	await until(() => h.term.text().includes("RUNNING"), "first frame");
	const s = h.term.screen();
	assert.equal(s.length, 50);
	for (const row of s) assert.equal([...row].length, 200);
	assert.match(s[0], /^╭─+╮$/);
	assert.match(s[3], /^│ ● RUNNING {3}█+⣿+ {2}1\/2 {2}ETA n\/a {3}iteration 1\/9 {2}1 item left {2}│$/);
	// One status row from 150 columns, so the split divider is row 4. Owner Q2: 46 | 200 - 4 - 46 - 64 = 86 | 64.
	assert.equal(s[4].indexOf("┬"), 47);
	assert.equal(s[4].lastIndexOf("┬"), 134);
	for (let row = 5; row <= 44; row++) for (const col of [0, 47, 134, 199]) assert.equal(s[row][col], "│");
	assert.equal(s[45].indexOf("┴"), 47);
	assert.equal(s[45].lastIndexOf("┴"), 134);
	assert.match(s[5], /^│ Items +1\/2 │ ● Current item B {2}Evil +title +│ Iterations +run 1 │$/);
	assert.match(s[6], /^│ ✓ A Parse config +│ c +│ iteration 1\/9 +│$/);
	assert.match(s[46], /^│ activity unavailable.*│$/);
	assert.match(s[47], /^├─+┤$/);
	assert.match(s[48], /^│ ↑↓ Items  ⏎ Detail  p Progress  a Activity  ⇧Q Quit +│$/);
	assert.match(s[49], /^╰─+╯$/);
	await quitByKeys(h);
});

test("at 150 columns the header keeps the token group with a long branch and model (review r1 P2)", async (t) => {
	const f = runningLoop(t);
	f.git("checkout", "-qb", "rw/typed-session-validation");
	f.journal([
		{ v: 1, k: "loop", r: "L1", t: T("10:00"), tok: "run-a", sa: T("10:00"), i: 1, ph: "initialized" },
		{ v: 1, k: "u", r: "L1", t: T("11:00"), tok: "run-a", i: 1, in: 3_200_000, out: 215_000, cr: 41_600_000, cw: 0, c: 18.61, n: 1, dc: 0, pr: 0 },
	]);
	f.state(true, T("10:00"), "run-a", { owner_heartbeat_at: NOW, model_id: "claude-opus-4-5-20251101" });
	const h = start(f.root, new ReplayTerminal(150, 30));
	await until(() => h.term.text().includes("Cached"), "header with tokens");
	const s = h.term.screen();
	// Left: title 14 + 2 + worktree (ralph-loop-state-XXXXXX, 23) + 2 + branch 29 = 70; the model (+26) would pass 148 - 2 - 65.
	assert.match(s[1], /^│ ◆ Ralph Watch {2}ralph-loop-state-\S{6} {2}⎇ rw\/typed-session-validation +hb 0s · event · Time 2h 00m · In 3\.2M · Cached 41\.6M · Out 215k · \$18\.61 │$/);
	assert.equal([...s[1]].length, 150);
	await quitByKeys(h);
});

test("resize to phone width drops the outer frame; a tiny terminal renders truncated without a minimum", async (t) => {
	const f = runningLoop(t);
	const h = start(f.root, new ReplayTerminal(200, 50));
	await until(() => h.term.text().includes("RUNNING"), "first frame");
	h.term.resize(79, 24);
	await until(() => h.term.screen()[0].includes("Ralph Watch"), "phone frame");
	const s = h.term.screen();
	assert.ok(!h.term.text().includes("╭") && !h.term.text().includes("│"), h.term.text());
	// Design spec section 4: header (2), rule, status (3), rule, current item, rule, tabs/keys.
	assert.match(s[0], /^ ◆ Ralph Watch +$/);
	assert.match(s[1], /^ ralph-loop-state-\S+ · \S+ +$/);
	for (const row of [2, 7, 21]) assert.match(s[row], /^─{79}$/);
	assert.match(s[3], /^ ● RUNNING +$/);
	assert.match(s[4], /^ █+⣿+ {2}1\/2 $/);
	assert.match(s[5], /^ iteration 1\/9 · 1 item left · ETA n\/a +$/);
	assert.match(s[6], /^ hb 0s · event +$/);
	assert.match(s[8], /^ ● Current item B {2}Evil +title +$/);
	assert.match(s[22], /^ activity unavailable.*$/);
	assert.match(s[23], /^ ↑↓ Items  ⏎ Detail  p Progress  a Activity  ⇧Q Quit +$/);
	// Owner, 2026-10-01: no minimum size; render the phone layout and truncate.
	h.term.resize(12, 3);
	await until(() => h.term.screen()[0].startsWith(" ◆ Ralph Wa"), "tiny frame");
	assert.deepEqual(h.term.screen(), [" ◆ Ralph Wa…", " ralph-loop…", "────────────"]);
	assert.equal(h.resolved(), false);
	// The footer is cut off at this size; double Ctrl+C still quits.
	h.term.send("\x03");
	h.term.send("\x03");
	await h.done;
});

test("untrusted item text is drawn without its terminal sequences", async (t) => {
	const f = runningLoop(t);
	const h = start(f.root, new ReplayTerminal(80, 24));
	await until(() => h.term.text().includes("Evil"), "first frame");
	const all = h.term.writes.join("");
	assert.ok(!all.includes("pwned"), "OSC title payload must not reach the terminal");
	assert.ok(!all.includes("\x1b]0;"));
	await quitByKeys(h);
});

// ---- Quit keys and stop ----

test("plain q only shows a hint; Shift+Q asks, n stays, y quits and leaves nothing on the main screen", async (t) => {
	const f = runningLoop(t);
	const h = start(f.root, new ReplayTerminal(80, 24));
	await until(() => h.term.text().includes("RUNNING"), "first frame");
	h.term.send("q");
	await until(() => h.term.text().includes("Shift+Q to quit"), "q hint");
	assert.equal(h.resolved(), false);
	h.term.send("Q");
	await until(() => h.term.text().includes("Quit Ralph Watch? The loop keeps running."), "quit prompt");
	h.term.send("n");
	await until(() => !h.term.text().includes("Quit Ralph Watch?"), "prompt closed");
	assert.equal(h.resolved(), false);
	await quitByKeys(h);
	assert.equal(h.term.stopped, true);
	assert.equal(h.closed(), true, "quit closes the viewer's reader");
	// TuiAltScreen prints the root's unbounded render on stop; the root returns [] so no frame lands there.
	const leaked = h.term.afterStop.join("").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
	assert.equal(leaked.trim(), "", JSON.stringify(leaked));
	// The refresh timer is cleared: a tick after quit reads nothing.
	const reads = h.reads();
	h.tick();
	assert.equal(h.reads(), reads);
});

test("double Ctrl+C quits only within 1.5 s", async (t) => {
	const f = runningLoop(t);
	const h = start(f.root, new ReplayTerminal(80, 24));
	await until(() => h.term.text().includes("RUNNING"), "first frame");
	h.term.send("\x03");
	await until(() => h.term.text().includes("Ctrl+C again to quit"), "Ctrl+C hint");
	h.advance(1_600);
	h.term.send("\x03");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(h.resolved(), false, "a second press after 1.6 s starts a new window");
	h.advance(1_000);
	h.term.send("\x03");
	await h.done;
	assert.equal(h.term.stopped, true);
});

test("Kitty key releases are ignored", async (t) => {
	const f = runningLoop(t);
	const h = start(f.root, new ReplayTerminal(80, 24));
	await until(() => h.term.text().includes("RUNNING"), "first frame");
	// Kitty protocol release events (event type 3): Shift+Q, then Ctrl+C twice.
	h.term.send("\x1b[113;2:3u");
	h.term.send("\x1b[99;5:3u");
	h.term.send("\x1b[99;5:3u");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(h.resolved(), false);
	assert.ok(!h.term.text().includes("Quit Ralph Watch?"));
	assert.ok(!h.term.text().includes("Ctrl+C again"));
	await quitByKeys(h);
});

test("Kitty-encoded presses: q shows the hint, Shift+Q asks, n stays, y quits", async (t) => {
	const f = runningLoop(t);
	const h = start(f.root, new ReplayTerminal(80, 24));
	await until(() => h.term.text().includes("RUNNING"), "first frame");
	// Kitty keyboard protocol presses (CSI codepoint;modifier u): q, Shift+Q, n, y.
	h.term.send("\x1b[113u");
	await until(() => h.term.text().includes("Shift+Q to quit"), "q hint");
	h.term.send("\x1b[113;2u");
	await until(() => h.term.text().includes("Quit Ralph Watch?"), "quit prompt");
	h.term.send("\x1b[110u");
	await until(() => !h.term.text().includes("Quit Ralph Watch?"), "prompt closed");
	assert.equal(h.resolved(), false);
	h.term.send("\x1b[113;2u");
	await until(() => h.term.text().includes("Quit Ralph Watch?"), "quit prompt again");
	h.term.send("\x1b[121u");
	await h.done;
	assert.equal(h.term.stopped, true);
});

/** A terminal whose size reads fail only inside the viewer's root geometry callback (`regions`). */
class LayoutFaultTerminal extends ReplayTerminal {
	fail = false;
	private check(): void {
		// Stack line 3 is the caller of the getter (after Error, check and the getter); pi-tui size reads pass.
		if (this.fail && /\bregions\b/.test(new Error().stack?.split("\n")[3] ?? "")) throw new Error("geometry broke");
	}
	override get columns(): number { this.check(); return super.columns; }
	override get rows(): number { this.check(); return super.rows; }
}

test("a root layout failure draws an error frame, keeps keys working, recovers and quits cleanly", async (t) => {
	const f = runningLoop(t);
	const term = new LayoutFaultTerminal(80, 24);
	const h = start(f.root, term);
	await until(() => term.text().includes("RUNNING"), "first frame");
	term.fail = true;
	h.tick();
	await until(() => term.text().includes("Ralph Watch could not draw: geometry broke"), "error frame");
	assert.equal(h.resolved(), false);
	assert.equal(term.stopped, false);
	// Keys still work while the layout fails; the error frame shows the prompt.
	h.term.send("\x1b[113;2u");
	await until(() => term.text().includes("Quit Ralph Watch?"), "prompt in error frame");
	h.term.send("n");
	await until(() => !term.text().includes("Quit Ralph Watch?"), "prompt closed");
	term.fail = false;
	h.tick();
	await until(() => term.screen()[0].startsWith("╭") && term.text().includes("RUNNING"), "recovered frame");
	assert.ok(!term.text().includes("could not draw"), term.text());
	assert.match(term.screen()[23], /^╰─+╯$/);
	await quitByKeys(h);
	assert.equal(term.stopped, true);
	assert.equal(h.closed(), true);
});

// ---- Errors and refresh ----

test("a panel error shows inline in that panel; the rest of the frame stays", async (t) => {
	const f = runningLoop(t);
	const h = start(f.root, new ReplayTerminal(80, 24), (reader) => ({
		read: async (signal) => {
			const snapshot = await reader.read(signal);
			return Object.defineProperty({ ...snapshot }, "currentItem", { get() { throw new Error("bad \x1b[2Jitem"); } }) as LoopSnapshot;
		},
		close: () => reader.close(),
	}));
	await until(() => h.term.text().includes("failed"), "panel error");
	const s = h.term.screen();
	assert.match(s[6], /^│ Current item +│ Items +1\/2 │$/);
	assert.match(s[7], /^│ ✕ Current item failed: bad item +│ ✓ A Parse config +│$/);
	assert.match(s[3], /^│ ● RUNNING {3}█+⣿+ {2}1\/2 {2}│$/);
	assert.match(s[23], /^╰─+╯$/);
	await quitByKeys(h);
});

test("a refresh failure redraws with the error, keeps running and recovers on the next tick", async (t) => {
	const f = runningLoop(t);
	let fail = false;
	const h = start(f.root, new ReplayTerminal(80, 24), (reader) => ({
		read: (signal) => fail ? Promise.reject(new Error("disk gone")) : reader.read(signal),
		close: () => reader.close(),
	}));
	await until(() => h.term.text().includes("RUNNING"), "first frame");
	assert.equal(h.interval(), 2_000);
	fail = true;
	h.tick();
	await until(() => h.term.text().includes("refresh failed: disk gone"), "error line");
	const s = h.term.screen();
	// The last good snapshot stays on screen next to the error.
	assert.match(s[3], /^│ ● RUNNING {3}█+[▏▎▍▌▋▊▉]?⣿+ {2}1\/2 {2}✕ refresh failed: disk gone {2}│$/);
	assert.match(s[0], /^╭─+╮$/);
	assert.equal(h.resolved(), false);
	fail = false;
	h.tick();
	await until(() => !h.term.text().includes("refresh failed"), "recovery");
	await quitByKeys(h);
});

test("a slow read is never overlapped by the next refresh tick", async (t) => {
	const f = runningLoop(t);
	let release: (() => void) | null = null;
	let hold = false;
	const h = start(f.root, new ReplayTerminal(80, 24), (reader) => ({
		read: async (signal) => {
			if (hold) await new Promise<void>((resolve) => { release = resolve; });
			return reader.read(signal);
		},
		close: () => reader.close(),
	}));
	await until(() => h.term.text().includes("RUNNING"), "first frame");
	hold = true;
	h.tick();
	const reads = h.reads();
	h.tick();
	h.tick();
	assert.equal(h.reads(), reads);
	hold = false;
	await until(() => release !== null, "held read");
	release!();
	// Once the held read settles, the next tick reads again.
	await until(() => { h.tick(); return h.reads() === reads + 1; }, "read after release");
	await quitByKeys(h);
});

test("runViewer rejects a missing root before it opens the alternate screen", async () => {
	const term = new ReplayTerminal(80, 24);
	await assert.rejects(runViewer({ roots: ["/nonexistent/ralph-root"] }, {
		terminal: term, now: Date.now, setInterval: () => 0, clearInterval: () => {}, openLoop: (r) => openLoop(r),
	}), /ENOENT|no such file/);
	assert.equal(term.started, false);
	assert.equal(term.writes.length, 0);
});


const liveHello = (nextSeq = 1, lastPiAt = NOW): Extract<EventFrame, { type: "hello" }> => ({ v: 1, type: "hello", launchId: "L1", pid: 1, nextSeq, lastPiAt, loop: { token: "run-a", startedAt: T("10:00"), iteration: 1 }, tools: [{ id: "replayed", name: "read", label: "buffered.ts", startedAt: NOW, endedAt: null }], totals: emptyTotals(), counters: { dialogsCancelled: 0, refusals: 0, badRecords: 0, badFacts: 0, subscriberDrops: 0 }, state: "launched" });
const waitAbort = (signal?: AbortSignal) => new Promise<void>((resolve) => {
	if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true });
});

for (const [cols, rows] of [[80, 24], [120, 40], [200, 50], [60, 30]]) test(`live feed at ${cols}x${rows}: replay, messages, filter keys and sanitized terminal output`, async (t) => {
	const f = runningLoop(t);
	const h = start(f.root, new ReplayTerminal(cols, rows), (r) => r, async function* (_, signal) {
		yield liveHello();
		yield { v: 1, type: "event", seq: 1, at: NOW, event: { kind: "message", text: "agent text\x1b]0;HOSTILE\x07\x1b[2J\r\u009b" } };
		await waitAbort(signal);
	});
	t.after(async () => { if (!h.resolved()) { h.term.send("\x03"); h.term.send("\x03"); await h.done; } });
	await until(() => h.term.text().includes("agent text"), "overview live row");
	h.term.send("a");
	await until(() => h.term.text().includes("Activity · all"), "Activity screen");
	assert.match(h.term.text(), /Read buffered.ts/);
	assert.match(h.term.text(), /◆ agent text/);
	h.term.send("F");
	await until(() => h.term.text().includes("Activity · tools"), "tools filter");
	assert.ok(!h.term.text().includes("agent text"));
	h.term.send("F");
	await until(() => h.term.text().includes("Activity · messages"), "messages filter");
	assert.ok(!h.term.text().includes("buffered.ts"));
	h.term.send("F");
	await until(() => h.term.text().includes("Activity · errors"), "errors filter");
	h.term.send("F");
	await until(() => h.term.text().includes("Activity · all"), "all filter");
	h.term.send("\x1b");
	await until(() => h.term.text().includes("Current item"), "back to overview");
	assert.doesNotMatch(h.term.writes.join(""), /HOSTILE|\u009b|\x1b]0;/);
	await quitByKeys(h);
});

test("event disconnect never invents STALLED; reconnect waits for the refresh tick and shows a gap", async (t) => {
	const f = runningLoop(t);
	let attempts = 0;
	const h = start(f.root, new ReplayTerminal(200, 50), (r) => r, async function* (_, signal) {
		attempts++;
		yield liveHello(attempts === 1 ? 1 : 5, T("11:00"));
		if (attempts === 1) throw new Error("lost stream");
		await waitAbort(signal);
	});
	t.after(async () => { if (!h.resolved()) { h.term.send("\x03"); h.term.send("\x03"); await h.done; } });
	await until(() => h.term.text().includes("lost stream"), "disconnect row");
	assert.ok(!h.term.text().includes("STALLED"));
	assert.equal(attempts, 1);
	h.tick();
	await until(() => h.term.text().includes("STALLED"), "reconnected stale pi receive time");
	assert.equal(attempts, 2);
	assert.match(h.term.text(), /event 1h 00m/);
	h.term.send("a");
	await until(() => h.term.text().includes("Activity · all") && h.term.text().includes("activity gap"), "gap row");
	assert.match(h.term.text(), /Read buffered.ts/);
	await quitByKeys(h);
});

test("a mismatched hello stays unavailable and does not establish live liveness", async (t) => {
	const f = runningLoop(t);
	const h = start(f.root, new ReplayTerminal(200, 50), (r) => r, async function* () {
		yield { ...liveHello(1, T("10:00")), loop: { token: "other", startedAt: T("10:00"), iteration: 1 } };
	});
	t.after(async () => { if (!h.resolved()) { h.term.send("\x03"); h.term.send("\x03"); await h.done; } });
	await until(() => h.term.text().includes("does not match"), "identity failure");
	assert.ok(!h.term.text().includes("STALLED"));
	assert.ok(!h.term.text().includes("buffered.ts"));
	await quitByKeys(h);
});

test("a relaunch reconnects to the fresh run and clears old activity; a quiet restart cannot prove a stall", async (t) => {
	const f = runningLoop(t);
	let attempts = 0;
	const h = start(f.root, new ReplayTerminal(200, 50), (r) => r, async function* (_, signal) {
		attempts++;
		if (attempts === 1) yield liveHello();
		else yield { ...liveHello(), lastPiAt: null, loop: { token: "run-b", startedAt: NOW, iteration: 1 }, tools: [{ id: "fresh", name: "edit", label: "new.ts", startedAt: null, endedAt: null }] };
		await waitAbort(signal);
	});
	t.after(async () => { if (!h.resolved()) { h.term.send("\x03"); h.term.send("\x03"); await h.done; } });
	await until(() => h.term.text().includes("buffered.ts"), "old run replay");
	f.state(true, NOW, "run-b", { owner_heartbeat_at: NOW });
	h.tick();
	await until(() => h.term.text().includes("new.ts"), "new run replay");
	assert.equal(attempts, 2);
	assert.ok(!h.term.text().includes("STALLED"));
	h.term.send("a");
	await until(() => h.term.text().includes("Activity · all"), "new run Activity");
	assert.ok(!h.term.text().includes("buffered.ts"));
	assert.match(h.term.text(), /Edit new.ts/);
	await quitByKeys(h);
});

for (const cols of [80, 150, 170, 200]) test(`desktop ${cols} columns closes column rules before Live, then separates the footer`, async (t) => {
	const f = runningLoop(t);
	const h = start(f.root, new ReplayTerminal(cols, 24));
	t.after(async () => { if (!h.resolved()) { h.term.send("\x03"); h.term.send("\x03"); await h.done; } });
	await until(() => h.term.text().includes("RUNNING"), "desktop frame");
	const rows = h.term.screen();
	const split = cols >= 150 ? 4 : 5;
	const junctions = [...rows[split]].flatMap((c, i) => c === "┬" ? [i] : []);
	assert.equal(junctions.length, cols >= 170 ? 2 : 1);
	for (const col of junctions) {
		assert.equal(rows[18][col], "│", "column reaches the closing divider");
		assert.equal(rows[19][col], "┴", "junction directly under the column");
	}
	assert.match(rows[20], /^│ activity unavailable.*│$/);
	assert.match(rows[21], /^├─+┤$/);
	assert.match(rows[22], /^│ .*a Activity.*Quit.*│$/);
	await quitByKeys(h);
});

test("80-column unavailable header keeps the branch and leaves the full unavailable text only in Live", async (t) => {
	const f = runningLoop(t);
	f.git("checkout", "-qb", "r1");
	const h = start(f.root, new ReplayTerminal(80, 24));
	t.after(async () => { if (!h.resolved()) { h.term.send("\x03"); h.term.send("\x03"); await h.done; } });
	await until(() => h.term.text().includes("RUNNING"), "unavailable frame");
	assert.match(h.term.screen()[1], /⎇ r1/);
	assert.match(h.term.screen()[1], /event/);
	assert.equal(h.term.text().split("activity unavailable").length - 1, 1);
	await quitByKeys(h);
});

test("persisted enforcer alerts drive the production chip; unavailable enforcer status stays visible", async t => {
	const f = runningLoop(t);
	const { appendAlerts, writeEnforcerStatus } = await import("../src/watch/alert-log.ts");
	const run = { launchId: "viewer", loopToken: "run-a", startedAt: T("10:00") };
	await appendAlerts(f.root, [{ timestamp: NOW, level: "WARN", rule: "test-edit", item: "B", commit: null, evidence: ["edited test"], run }]);
	await writeEnforcerStatus(f.root, { v: 1, pid: process.pid, run, configHash: "pinned", state: "ready", polledAt: NOW, commitsChecked: 3, counts: { HARD: 0, WARN: 1, INFO: 0 }, stop: null });
	const h = start(f.root, new ReplayTerminal(200, 50));
	try {
		await until(() => h.term.text().includes("enforcer 1 warn"), "persisted WARN chip");
		await writeEnforcerStatus(f.root, { v: 1, pid: process.pid, run, configHash: "pinned", state: "down", polledAt: NOW, commitsChecked: 3, counts: { HARD: 0, WARN: 1, INFO: 0 }, stop: null });
		h.tick(); await until(() => h.term.text().includes("enforcer down"), "down chip");
	} finally { await quitByKeys(h); }
});

// ---- Item detail, Diff and Progress (#16) ----

const footerOf = (term: ReplayTerminal) => term.screen()[term.screen().length - 2];
const SGR_GREEN_ADD = "\x1b[32m+";

/** Item A blocked, then passed (two commits); item B current. `sourceLines` adds a source file to the pass commit. */
function detailLoop(t: test.TestContext, sourceLines = 0): Fixture {
	const f = new Fixture([{ id: "A", title: "Parse config", passes: false }, { id: "B", title: "Second", passes: false }]);
	t.after(() => f.close());
	f.block("A", T("10:00"));
	if (sourceLines > 0) writeFileSync(path.join(f.root, "a.ts"), Array.from({ length: sourceLines }, (_, i) => `export const v${i} = ${i};\n`).join(""));
	f.pass("A", T("10:10"));
	f.state(true, T("09:59"), "run-a", { owner_heartbeat_at: NOW });
	return f;
}

test("Detail lists persisted enforcer findings under the commit they name", async (t) => {
	const f = detailLoop(t);
	const pass = f.git("rev-parse", "HEAD");
	const { appendAlerts, writeEnforcerStatus } = await import("../src/watch/alert-log.ts");
	const run = { launchId: "viewer", loopToken: "run-a", startedAt: T("09:59") };
	await appendAlerts(f.root, [{ timestamp: NOW, level: "WARN", rule: "test-edit", item: "A", commit: pass, evidence: ["edited test"], run }]);
	await writeEnforcerStatus(f.root, { v: 1, pid: process.pid, run, configHash: "pinned", state: "ready", polledAt: NOW, commitsChecked: 2, counts: { HARD: 0, WARN: 1, INFO: 0 }, stop: null });
	const h = start(f.root, new ReplayTerminal(120, 40));
	await until(() => h.term.text().includes("Current item B"), "overview");
	h.term.send("k");
	h.term.send("\r");
	await until(() => h.term.text().includes("Commits"), "detail");
	await until(() => h.term.text().includes("⚠ test-edit"), "finding under the pass commit");
	await quitByKeys(h);
});

test("navigation: select, Enter opens Detail, D opens a coloured Diff, [ ] step commits, Esc goes back one level", async (t) => {
	const f = detailLoop(t);
	const h = start(f.root, new ReplayTerminal(120, 40));
	await until(() => h.term.text().includes("Current item B"), "overview");
	assert.match(footerOf(h.term), /^│ ↑↓ Items {2}⏎ Detail {2}p Progress {2}a Activity {2}⇧Q Quit +│$/);
	// The default selection is the current item; k moves it up to A.
	h.term.send("k");
	h.term.send("\r");
	await until(() => h.term.text().includes("Commits"), "detail");
	assert.ok(h.term.text().includes("✓ A  Parse config"));
	assert.match(footerOf(h.term), /^│ ↑↓ Items {2}D Diff {2}P Raw {2}Esc Back {2}⇧Q Quit +│$/);
	h.term.send("D");
	await until(() => h.term.text().includes("diff --git a/.ralph/items.json"), "diff");
	assert.match(h.term.text(), /[0-9a-f]{7} feat: A +1\/2/);
	assert.ok(h.term.writes.join("").includes(SGR_GREEN_ADD), "additions are green");
	assert.match(footerOf(h.term), /^│ \[ \] Commit {2}↑↓ Scroll {2}Esc Item {2}⇧Q Quit +│$/);
	// `[` steps to the older commit (the blocker), `]` back; the Kitty-encoded `[` works the same.
	h.term.send("[");
	await until(() => /blocked\(A\): gate +2\/2/.test(h.term.text()), "older commit");
	h.term.send("\x1b[93u");
	await until(() => /feat: A +1\/2/.test(h.term.text()), "newer commit");
	h.term.send("\x1b[91u");
	await until(() => /blocked\(A\): gate +2\/2/.test(h.term.text()), "kitty [");
	h.term.send("\x1b");
	await until(() => h.term.text().includes("Commits"), "back to detail");
	h.term.send("\x1b");
	await until(() => h.term.text().includes("Current item B"), "back to overview");
	await quitByKeys(h);
});

test("a git error shows inline in the Diff body; Esc still goes back", async (t) => {
	const f = detailLoop(t);
	const shown: string[] = [];
	const h = start(f.root, new ReplayTerminal(100, 30), undefined, {
		showCommit: async (_root, sha) => { shown.push(sha); throw new Error("bad object \x1b]0;pwn\x07here"); },
	});
	await until(() => h.term.text().includes("Current item B"), "overview");
	h.term.send("k");
	h.term.send("\r");
	await until(() => h.term.text().includes("Commits"), "detail");
	h.term.send("D");
	await until(() => h.term.text().includes("✕ git show failed: bad object here"), "inline git error");
	// Only verified full SHAs from the snapshot history reach git.
	assert.deepEqual(shown.map((sha) => /^[0-9a-f]{40}$/.test(sha)), [true]);
	assert.ok(!h.term.writes.join("").includes("pwn"));
	h.term.send("\x1b");
	await until(() => h.term.text().includes("Commits"), "back to detail");
	await quitByKeys(h);
});

test("P toggles raw and parsed in Detail and Progress; Esc first cancels the quit prompt", async (t) => {
	const f = detailLoop(t);
	const h = start(f.root, new ReplayTerminal(120, 40));
	await until(() => h.term.text().includes("Current item B"), "overview");
	h.term.send("k");
	h.term.send("\r");
	await until(() => h.term.text().includes("Commits"), "detail");
	assert.ok(!h.term.text().includes("# A passed: done"));
	// Kitty-encoded Shift+P press, then its release (ignored).
	h.term.send("\x1b[112;2u");
	h.term.send("\x1b[112;2:3u");
	await until(() => h.term.text().includes("# A passed: done"), "raw entry");
	assert.match(footerOf(h.term), /P Parsed/);
	h.term.send("P");
	await until(() => !h.term.text().includes("# A passed: done"), "parsed again");
	// The quit prompt consumes Esc; the screen stays.
	h.term.send("Q");
	await until(() => h.term.text().includes("Quit Ralph Watch?"), "quit prompt");
	h.term.send("\x1b");
	await until(() => !h.term.text().includes("Quit Ralph Watch?"), "prompt closed");
	assert.ok(h.term.text().includes("Commits"));
	// p opens Progress: newest entry first, raw toggle there too.
	h.term.send("p");
	await until(() => h.term.text().includes("1 passed · 1 blocked"), "progress");
	const body = h.term.screen().join("\n");
	assert.ok(body.indexOf("A ✓ passed") < body.indexOf("A ✕ blocked"), "newest first");
	assert.match(footerOf(h.term), /^│ ↑↓ Scroll {2}P Raw {2}Esc Back {2}⇧Q Quit +│$/);
	h.term.send("P");
	await until(() => h.term.text().includes("# A blocked: gate"), "raw progress");
	h.term.send("\x1b");
	await until(() => h.term.text().includes("Commits"), "back to detail");
	await quitByKeys(h);
});

test("Diff and Progress scroll with ↑↓, j k and PgUp/PgDn at 80x24; the phone layout opens the same screens", async (t) => {
	const f = detailLoop(t, 60);
	const h = start(f.root, new ReplayTerminal(80, 24));
	await until(() => h.term.text().includes("Current item B"), "overview");
	h.term.send("k");
	h.term.send("\r");
	h.term.send("D");
	await until(() => h.term.text().includes("diff --git"), "diff");
	const firstBody = () => h.term.screen()[7];
	assert.match(firstBody(), /│ commit [0-9a-f]{7}/);
	h.term.send("j");
	await until(() => /│ feat: A/.test(firstBody()), "scrolled one row");
	h.term.send("k");
	await until(() => /│ commit [0-9a-f]{7}/.test(firstBody()), "scrolled back");
	h.term.send("\x1b[6~");
	await until(() => !/│ commit [0-9a-f]{7}|feat: A/.test(firstBody()), "page down");
	h.term.send("\x1b[5~");
	await until(() => /│ commit [0-9a-f]{7}/.test(firstBody()), "page up");
	h.term.resize(62, 48);
	await until(() => h.term.screen()[0].startsWith(" ◆ Ralph Watch") && h.term.text().includes("diff --git"), "phone diff");
	assert.match(h.term.screen()[47], /\[ \] Commit/);
	await quitByKeys(h);
});

// ---- Round 1 review regressions (#16) ----

/** Custom user bindings the viewer must give back on every exit path. */
function customBindings(t: test.TestContext) {
	const keybindings = getKeybindings();
	const before = keybindings.getUserBindings();
	const custom = { ...before, "tui.altScreen.pageUp": ["ctrl+u"], "tui.altScreen.pageDown": ["ctrl+d"] } as typeof before;
	keybindings.setUserBindings(custom);
	t.after(() => keybindings.setUserBindings(before));
	return () => assert.deepEqual(keybindings.getUserBindings(), custom);
}

test("a failed terminal start restores the key bindings, closes the reader and leaves the alternate screen", async (t) => {
	const f = runningLoop(t);
	const restored = customBindings(t);
	class FailingStart extends ReplayTerminal {
		override start(): void { throw new Error("no tty"); }
	}
	const h = start(f.root, new FailingStart(80, 24));
	await assert.rejects(h.done, /no tty/);
	restored();
	assert.equal(h.closed(), true);
	assert.equal(h.term.stopped, true);
});

test("a throwing terminal stop still restores the key bindings, closes the reader and rejects the viewer", async (t) => {
	const f = runningLoop(t);
	const restored = customBindings(t);
	class FailingStop extends ReplayTerminal {
		override stop(): void { super.stop(); throw new Error("stop failed"); }
	}
	const h = start(f.root, new FailingStop(80, 24));
	await until(() => h.term.text().includes("Current item"), "first frame");
	h.term.send("Q");
	await until(() => h.term.text().includes("Quit Ralph Watch?"), "quit prompt");
	h.term.send("y");
	await assert.rejects(h.done, /stop failed/);
	restored();
	assert.equal(h.closed(), true);
});

test("at 80x24 the Items panel follows the selection; Enter opens the visible selected item", async (t) => {
	// 20 items, 14 passed: the current item A15 is below the 14 Items rows a top-aligned list shows.
	const items = Array.from({ length: 20 }, (_, i) => ({ id: `A${String(i + 1).padStart(2, "0")}`, title: `Item ${i + 1}`, passes: false }));
	const f = new Fixture(items);
	t.after(() => f.close());
	for (let i = 0; i < 14; i++) f.pass(items[i].id, T(`10:${String(i + 10).padStart(2, "0")}`));
	f.state(true, T("10:00"), "run-a", { owner_heartbeat_at: NOW });
	const h = start(f.root, new ReplayTerminal(80, 24));
	const itemsColumn = () => h.term.screen().slice(7, 21).map((row) => row.slice(44));
	const inverseRow = (id: string) => h.term.writes.some((w) => new RegExp(`\\x1b\\[7m[^\\n]*${id} Item`).test(w));
	await until(() => itemsColumn().some((row) => row.includes("● A15 Item 15")), "current item visible");
	assert.ok(inverseRow("A15"), "the default selection is drawn inverse");
	h.term.send("j");
	await until(() => itemsColumn().some((row) => row.includes("○ A16 Item 16")) && inverseRow("A16"), "A16 visible and selected");
	assert.equal(itemsColumn().length, 14);
	h.term.send("\r");
	await until(() => /○ A16  Item 16/.test(h.term.text()), "detail of A16");
	// Moving back to the top scrolls the list back.
	h.term.send("\x1b");
	for (let i = 0; i < 16; i++) h.term.send("k");
	await until(() => itemsColumn()[0].includes("✓ A01 Item 1"), "top of the list");
	await quitByKeys(h);
});

test("Overview: PgUp/PgDn scroll an overflowing Current item card and return to the first row", async (t) => {
	const f = new Fixture([{ id: "A", passes: false }, { id: "B", title: "Second", passes: false }]);
	t.after(() => f.close());
	f.pass("A", T("10:00"));
	// Nine blocked attempts on B overflow the 14-row Current item body at 80x24.
	for (let i = 0; i < 9; i++) f.block("B", T(`10:${String(i + 10).padStart(2, "0")}`), `# B blocked: gate ${i}\n- Failing command: \`npm test\` exit 1.\n`);
	f.state(true, T("09:59"), "run-a", { owner_heartbeat_at: NOW });
	const h = start(f.root, new ReplayTerminal(80, 24));
	await until(() => h.term.text().includes("Current item B"), "overview");
	const firstBody = () => h.term.screen()[7];
	await until(() => /blockers/.test(firstBody()), "facts row first");
	const before = firstBody();
	h.term.send("\x1b[6~");
	await until(() => firstBody() !== before, "page down");
	assert.match(footerOf(h.term), /↑↓ Items/);
	h.term.send("\x1b[5~");
	await until(() => firstBody() === before, "page up");
	await quitByKeys(h);
});
