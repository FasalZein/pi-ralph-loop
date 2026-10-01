import assert from "node:assert/strict";
import test from "node:test";

import { openLoop } from "../src/watch/loop-state.ts";
import type { LoopReader, LoopSnapshot } from "../src/watch/types.ts";
import { runViewer, type ViewerRuntime } from "../src/watch/viewer.ts";
import { allocate, splitExact } from "../src/watch/viewer/layout.ts";
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

function start(root: string, term: ReplayTerminal, wrap: (reader: LoopReader) => LoopReader = (r) => r): Harness {
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

test("splitExact returns integer parts that sum to the total", () => {
	// Hand-computed largest remainder: 120 * 3/5 = 72, 120 * 2/5 = 48 (design spec: grow gave 95/25).
	assert.deepEqual(splitExact(120, [3, 2]), [72, 48]);
	// 77 * 50/76 = 50.66, 77 * 26/76 = 26.34; the one leftover column goes to the larger remainder.
	assert.deepEqual(splitExact(77, [50, 26]), [51, 26]);
	// 197 * 50/76 = 129.61, 197 * 26/76 = 67.39.
	assert.deepEqual(splitExact(197, [50, 26]), [130, 67]);
	assert.deepEqual(splitExact(10, [1, 1, 1]), [4, 3, 3]);
	assert.deepEqual(splitExact(0, [1, 1]), [0, 0]);
});

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
	assert.match(s[1], /^│ ◆ Ralph Watch {2}ralph-loop-state-\S+ {2}⎇ \S+ +│$/);
	assert.match(s[2], /^├─+┤$/);
	assert.match(s[3], /^│ ● RUNNING {3}1\/2 items +│$/);
	assert.match(s[4], /^│ +│$/);
	// Inner width 77 splits 50:26 into 51 and 26 (hand-computed above), so the junction is column 52.
	assert.equal(s[5].indexOf("┬"), 52);
	assert.match(s[5], /^├─+┬─+┤$/);
	for (let row = 6; row <= 20; row++) {
		assert.equal(s[row][0], "│");
		assert.equal(s[row][52], "│");
		assert.equal(s[row][79], "│");
	}
	assert.equal(s[21].indexOf("┴"), 52);
	assert.match(s[22], /^│ ⇧Q Quit +│$/);
	assert.match(s[23], /^╰─+╯$/);
	assert.match(s[6], /^│ Current item +│ Items {2}1\/2 +│$/);
	assert.match(s[7], /^│ ● B Evil +title +│ ✓ A Parse config +│$/);
	assert.match(s[8], /^│ +│ ● B Evil +title +│$/);
	await quitByKeys(h);
});

test("desktop frame at 200x50: status in one row and the wider exact split", async (t) => {
	const f = runningLoop(t);
	const h = start(f.root, new ReplayTerminal(200, 50));
	await until(() => h.term.text().includes("RUNNING"), "first frame");
	const s = h.term.screen();
	assert.equal(s.length, 50);
	for (const row of s) assert.equal([...row].length, 200);
	assert.match(s[0], /^╭─+╮$/);
	assert.match(s[3], /^│ ● RUNNING {3}1\/2 items +│$/);
	// One status row from 150 columns, so the split divider is row 4. Inner 197 splits into 130 and 67.
	assert.equal(s[4].indexOf("┬"), 131);
	for (let row = 5; row <= 46; row++) assert.equal(s[row][131], "│");
	assert.equal(s[47].indexOf("┴"), 131);
	assert.match(s[48], /^│ ⇧Q Quit +│$/);
	assert.match(s[49], /^╰─+╯$/);
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
	for (const row of [2, 6, 22]) assert.match(s[row], /^─{79}$/);
	assert.match(s[3], /^ ● RUNNING {3}1\/2 items +$/);
	assert.match(s[7], /^ Current item +$/);
	assert.match(s[23], /^ ⇧Q Quit +$/);
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
	assert.match(s[6], /^│ Current item +│ Items {2}1\/2 +│$/);
	assert.match(s[7], /^│ ✕ Current item failed: bad item +│ ✓ A Parse config +│$/);
	assert.match(s[3], /^│ ● RUNNING {3}1\/2 items +│$/);
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
	assert.match(s[3], /^│ ● RUNNING {3}1\/2 items {3}✕ refresh failed: disk gone +│$/);
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
