import path from "node:path";
import { type Component, getKeybindings, isKeyRelease, type KeyId, matchesKey, ProcessTerminal, type Terminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { connectEvents, matchingHello } from "./events.js";
import { activityRows, activityTitle } from "./viewer/activity.js";
import { applyFrame, disconnect, emptyFeed, FILTERS, type FeedFilter, type LiveFeed } from "./viewer/live.js";
import { openLoop } from "./loop-state.js";
import type { LoopReader, LoopSnapshot } from "./types.js";
import { allocate, clean, fit, Lines, message, Panel, type Region, Stack, style } from "./viewer/layout.js";
import { detailBody, detailTitle, itemCommits } from "./viewer/detail.js";
import { diffLines, type ShowCommit, showCommit, type ShownCommit } from "./viewer/diff.js";
import { currentBody, currentTitle, enforcerChip, headerLine, itemRows, itemsTitle, iterationsBody, iterationsTitle, phoneStatusRows, short, spread, statusRows } from "./viewer/overview.js";
import { progressBody, progressTitle } from "./viewer/progress-screen.js";

// Authority: spec #1 story 46 and the thresholds table ("Viewer refresh about 2 s"); design spec Behaviour.
export const REFRESH_MS = 2_000;
// Authority: ticket #14 and design spec section 7 ("Ctrl+C twice within 1.5 s").
export const QUIT_WINDOW_MS = 1_500;
// Authority: owner, 2026-10-01 on #14: the plain `q` hint shows as long as the quit window.
export const HINT_MS = QUIT_WINDOW_MS;
// Authority: design spec sections 3 and 4: phone layout below 80 columns.
export const PHONE_BELOW_COLS = 80;
// Authority: design spec section 3: status in one row from 150 columns, two rows below.
export const ONE_ROW_STATUS_COLS = 150;
// Authority: design spec section 4: the phone status block has three rows.
const PHONE_STATUS_ROWS = 3;
// Authority: design spec section 3: three columns (Items, Current item, Iterations) from 170 columns.
export const THREE_COLUMNS_COLS = 170;
// Authority: owner Q2 on #15 (prototype values, approved captures ov-80x24 and ov-120x40): below 170 columns
// the item list column is clamp(34, 60, round(0.38 * columns)).
const LIST_COL = { min: 34, max: 60, share: 0.38 } as const;
// Authority: owner Q2 on #15 (capture ov-200x50): from 170 columns Items 46 and the side column 64; the middle takes the rest.
const ITEMS_COL = 46;
const SIDE_COL = 64;
// Authority: pi interactive mode drains Kitty key releases for up to 1 s before it stops the terminal.
const DRAIN_INPUT_MS = 1_000;

export type ViewerRuntime = {
	readonly terminal: Terminal;
	readonly now: () => number;
	readonly setInterval: (fn: () => void, ms: number) => unknown;
	readonly clearInterval: (handle: unknown) => void;
	readonly openLoop: (root: string) => LoopReader;
	readonly connectEvents?: typeof connectEvents;
	/** Bounded read-only `git show` for the Diff screen; tests inject a recorder or a failing git. */
	readonly showCommit?: ShowCommit;
};

const defaultRuntime = (): ViewerRuntime => ({
	terminal: new ProcessTerminal(),
	now: Date.now,
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
	openLoop: (root) => openLoop(root),
});

/**
 * One level of the screen stack (Overview at the bottom; `Esc` pops one level, spec #1 story 95).
 * Detail follows the item selection; Diff keeps the item it opened on and the commit index (newest first).
 */
type Screen =
	| { readonly id: "overview" }
	| { readonly id: "detail" }
	| { readonly id: "diff"; readonly key: string; readonly index: number }
	| { readonly id: "progress" }
	| { readonly id: "activity" };

/** The Diff screen's one read: the commit it shows and its result, coloured once. */
type DiffRead = { readonly sha: string; readonly abort: AbortController; result: { readonly lines: readonly string[] } | { readonly error: string } | null };

/** Mutable viewer state. Snapshots stay immutable and are only replaced. */
type ViewerState = {
	snapshot: LoopSnapshot | null;
	/** The last refresh failure; cleared by the next successful read. */
	error: string | null;
	confirmQuit: boolean;
	lastCtrlCAt: number | null;
	stack: Screen[];
	/** The selected item key; a key that disappears falls back to the default selection. */
	selected: string | null;
	/** Raw progress entries instead of parsed cards, in Detail and Progress (spec #1 story 44). */
	raw: boolean;
	/** First body row shown in the main panel of the top screen. */
	scroll: number;
	/** First row shown in the Items panel; follows the selection so the selected row stays visible. */
	itemsTop: number;
	diff: DiffRead | null;
	filter: FeedFilter;
	live: LiveFeed;
};

/**
 * The top-level render boundary. pi-tui runs `doRender()` from its own render timer without an
 * exception handler, so a layout or root failure there would crash the process with the terminal
 * still in raw mode and on the alternate screen. This catch keeps the viewer alive; the next
 * requested render (refresh tick or key) retries with a full redraw.
 */
class GuardedAltScreen extends TuiAltScreen {
	constructor(terminal: Terminal, private readonly onRenderError: (error: unknown) => void) {
		super(terminal, false);
	}

	protected override doRender(): void {
		try {
			super.doRender();
		} catch (error) {
			// The screen no longer matches pi-tui's diff state; redraw everything next time.
			this.resetRenderState();
			this.onRenderError(error);
		}
	}
}

const QUIT_PROMPT = `Quit Ralph Watch? The loop keeps running.   ${style.bold("y")} quit   ${style.bold("n")} stay`;
const QUIT_KEYS = ` ${style.bold("⇧Q")} Quit`;
const hint = (keys: string, what: string) => `${style.bold(keys)} ${what}`;

/** The standalone Ralph Watch viewer. Resolves after a deliberate quit; never exits the process. */
export async function runViewer(spec: { readonly roots: readonly string[]; readonly initialRoot?: string }, runtime: ViewerRuntime = defaultRuntime()): Promise<void> {
	const root = spec.initialRoot ?? spec.roots[0];
	if (!root) throw new Error("ralph watch needs a loop root");
	// Fails before the alternate screen opens, so a bad root prints a plain error.
	const reader = runtime.openLoop(root);
	const { terminal } = runtime;
	const state: ViewerState = { snapshot: null, error: null, confirmQuit: false, lastCtrlCAt: null, stack: [{ id: "overview" }], selected: null, raw: false, scroll: 0, itemsTop: 0, diff: null, filter: "all", live: emptyFeed() };
	const show = runtime.showCommit ?? showCommit;
	// Drawn without pi-tui layout, so it works when the layout itself fails.
	const drawRenderError = (error: unknown) => {
		try {
			const width = Math.max(1, terminal.columns);
			const lines = [style.red(` ✕ Ralph Watch could not draw: ${clean(message(error))}`), state.confirmQuit ? ` ${QUIT_PROMPT}` : QUIT_KEYS];
			terminal.write(`\x1b[2J${lines.slice(0, Math.max(1, terminal.rows)).map((line, row) => `\x1b[${row + 1};1H${fit(line, width)}`).join("")}`);
		} catch {
			// Nothing more can be drawn; the next render retries.
		}
	};
	const tui = new GuardedAltScreen(terminal, drawRenderError);
	// TuiAltScreen's own viewport listener runs first and consumes PgUp/PgDn to scroll the whole root,
	// which always fits the screen. Owner Q5 on #16 gives these keys to the screen bodies, so they are
	// unbound for the viewer's lifetime (see `release`). Same API in pi-tui 0.84.4 and 1.0.4.
	const keybindings = getKeybindings();
	const userBindings = keybindings.getUserBindings();

	// ---- Regions ----
	const worktree = clean(path.basename(root));
	const branch = () => state.snapshot?.git?.branch ? clean(state.snapshot.git.branch) : null;
	const now = () => runtime.now();
	const header = new Lines((width) => [headerLine(state.snapshot, worktree, width, terminal.columns, state.live, now())], "header");
	const phoneHeader = new Lines(() => [` ${style.accent("◆")} ${style.bold("Ralph Watch")}`, ` ${worktree}${branch() ? ` · ${branch()}` : ""}`], "header");
	const chip = () => {
		const enforcer = state.snapshot?.enforcer;
		if (!enforcer) return null;
		return ["down", "unavailable"].includes(enforcer.status.state)
			? style.yellow(`⚠ enforcer ${enforcer.status.state}`)
			: enforcerChip(enforcer.alerts, enforcer.commitsChecked);
	};
	const status = new Lines((width) => statusRows(state.snapshot, width, terminal.columns >= ONE_ROW_STATUS_COLS ? 1 : 2, now(), state.error, chip(), state.live), "status");
	const phoneStatus = new Lines((width) => phoneStatusRows(state.snapshot, width, now(), state.error, chip(), state.live), "status");
	const footer = new Lines(() => [state.confirmQuit ? ` ${QUIT_PROMPT}` : ` ${[...hints(), QUIT_KEYS.trim()].join("  ")}`], "footer");
	const items = new Panel((width) => itemsTitle(state.snapshot, width), (width) => itemsInView(itemRows(state.snapshot, width, highlight())), "Items");
	// The highlight is decoration: a selection failure must not take the item list down with it.
	const highlight = () => { try { return selectedKey(); } catch { return null; } };
	// Rows of the main panel body; set by the layout pass, read by scrolling.
	let bodyRows = 0;
	// The Items panel shares the main row, so it has the same body height.
	const itemsInView = (rows: readonly string[]) => {
		const at = state.snapshot?.items.findIndex((item) => item.key === highlight()) ?? -1;
		if (at >= 0 && at < state.itemsTop) state.itemsTop = at;
		if (at >= 0 && at >= state.itemsTop + bodyRows) state.itemsTop = at - bodyRows + 1;
		state.itemsTop = Math.max(0, Math.min(state.itemsTop, rows.length - bodyRows));
		return rows.slice(state.itemsTop, state.itemsTop + bodyRows);
	};
	const scrolled = (lines: readonly string[]) => {
		state.scroll = Math.max(0, Math.min(state.scroll, lines.length - bodyRows));
		return lines.slice(state.scroll, state.scroll + bodyRows);
	};
	const current = new Panel(() => currentTitle(state.snapshot), (width) => scrolled(currentBody(state.snapshot, width)), "Current item");
	const screenPanel = new Panel((width) => screenTitle(width), (width) => scrolled(screenBody(width)), "Screen");
	// The main panel: Current item on Overview, else the top screen (the frame geometry stays).
	const main = () => (topScreen().id === "overview" ? current : screenPanel);
	const iterations = new Panel((width) => iterationsTitle(state.snapshot, width), () => iterationsBody(state.snapshot), "Iterations");

	let activityHeight = 0;
	const activityHeader = new Lines(() => [` ${activityTitle(state.filter)}`], "Activity");
	const activity = new Lines((width) => activityRows(state.live, state.filter, width, activityHeight), "Activity");
	const liveStrip = new Lines((width) => activityRows(state.live, "all", width, 1), "Activity");

	// ---- Screens ----
	const topScreen = (): Screen => state.stack[state.stack.length - 1];
	const selectedKey = (): string | null => {
		const snapshot = state.snapshot;
		if (!snapshot) return null;
		if (state.selected !== null && snapshot.items.some((item) => item.key === state.selected)) return state.selected;
		return snapshot.currentItem ?? snapshot.stoppedItem ?? snapshot.items[0]?.key ?? null;
	};
	/** The Diff screen's commit: only commits from the fresh snapshot history are ever shown. */
	const diffTarget = () => {
		const screen = topScreen();
		if (screen.id !== "diff" || !state.snapshot) return null;
		const commits = itemCommits(state.snapshot, screen.key);
		if (!commits.length) return null;
		const index = Math.min(screen.index, commits.length - 1);
		return { commit: commits[index], index, count: commits.length };
	};
	const loadDiff = () => {
		const target = diffTarget();
		if (state.diff && state.diff.sha !== target?.commit.sha) { state.diff.abort.abort(); state.diff = null; }
		if (!target || state.diff) return;
		const read: DiffRead = { sha: target.commit.sha, abort: new AbortController(), result: null };
		state.diff = read;
		show(root, read.sha, read.abort.signal).then(
			(shown: ShownCommit) => { read.result = { lines: diffLines(shown) }; },
			(error: unknown) => { read.result = { error: message(error) }; },
		).finally(() => { if (!stopped && state.diff === read) tui.requestRender(); });
	};
	const screenTitle = (width: number): string => {
		const screen = topScreen();
		switch (screen.id) {
			case "overview": case "activity": return currentTitle(state.snapshot);
			case "detail": return detailTitle(state.snapshot, selectedKey());
			case "progress": return progressTitle(state.snapshot, width);
			case "diff": {
				const target = diffTarget();
				if (!target) return style.bold("Diff");
				return spread(`${style.accent(short(target.commit.sha))} ${clean(target.commit.subject)}`, `${target.index + 1}/${target.count}`, width);
			}
		}
	};
	const screenBody = (width: number): readonly string[] => {
		const screen = topScreen();
		switch (screen.id) {
			case "overview": case "activity": return currentBody(state.snapshot, width);
			// Persisted enforcer alerts of the current launch (T12, #13); null when the enforcer view is absent.
			case "detail": return detailBody(state.snapshot, selectedKey(), width, { raw: state.raw, alerts: state.snapshot?.enforcer?.alerts ?? null });
			case "progress": return progressBody(state.snapshot, width, state.raw);
			case "diff": {
				if (!diffTarget()) return [style.dim(state.snapshot?.git?.commits ? "○ no commits for this item" : "○ commit history unknown")];
				const result = state.diff?.result;
				if (!result) return [style.dim("reading diff…")];
				return "error" in result ? [style.red(`✕ git show failed: ${clean(result.error)}`)] : result.lines;
			}
		}
	};
	const hints = (): string[] => {
		const screen = topScreen();
		const rawHint = hint("P", state.raw ? "Parsed" : "Raw");
		switch (screen.id) {
			case "overview": return state.snapshot?.items.length ? [hint("↑↓", "Items"), hint("⏎", "Detail"), hint("p", "Progress"), hint("a", "Activity")] : [hint("p", "Progress"), hint("a", "Activity")];
			case "activity": return [hint("F", "Filter"), hint("Esc", "Back")];
			case "detail": {
				const key = selectedKey();
				const diff = state.snapshot && key !== null && itemCommits(state.snapshot, key).length ? [hint("D", "Diff")] : [];
				return [hint("↑↓", "Items"), ...diff, rawHint, hint("Esc", "Back")];
			}
			case "diff": return [hint("[ ]", "Commit"), hint("↑↓", "Scroll"), hint("Esc", "Item")];
			case "progress": return [hint("↑↓", "Scroll"), rawHint, hint("Esc", "Back")];
		}
	};

	// ---- Frame (Look A on desktop, rules only on phones) ----
	// Inner column widths of the main row, left to right; junctions sit between them.
	let columns: readonly number[] = [];
	const rule = (left: string, fill: string, right: string, junction?: string) => new Lines((width) => {
		const inner = Math.max(0, width - 2);
		const body = junction ? columns.map((size) => fill.repeat(size)).join(junction) : fill.repeat(inner);
		return [style.dim(`${left}${fit(body, inner)}${right}`)];
	}, "frame");
	const top = rule("╭", "─", "╮");
	const divider = rule("├", "─", "┤");
	const open = rule("├", "─", "┤", "┬");
	const close = rule("├", "─", "┤", "┴");
	const bottom = rule("╰", "─", "╯");
	const phoneRule = new Lines((width) => [style.dim("─".repeat(width))], "frame");
	// The stack clips this leaf to the height of its row.
	const vrule = new Lines(() => Array.from({ length: terminal.rows }, () => style.dim("│")), "frame");
	const framed = (component: Component) => new Stack("hstack", () => [{ component: vrule, size: 1 }, { component, size: Math.max(0, terminal.columns - 2) }, { component: vrule, size: 1 }]);
	const [fHeader, fStatus, fFooter, fLive] = [header, status, footer, liveStrip].map(framed);
	const mainRow = new Stack("hstack", () => {
		const panels = columns.length === 3 ? [items, main(), iterations] : [main(), items];
		return [...panels.flatMap((component, index) => [{ component: vrule, size: 1 }, { component, size: columns[index] ?? 0 }]), { component: vrule, size: 1 }];
	});

	const regions = (): Region[] => {
		const cols = terminal.columns;
		const rows = terminal.rows;
		if (topScreen().id === "activity") {
			activityHeight = Math.max(0, rows - 3);
			const layout = [activityHeader, phoneRule, activity, footer];
			const sizes = allocate(rows, [1, 1, "rest", 1]);
			return layout.map((component, index) => ({ component, size: sizes[index] }));
		}
		if (cols < PHONE_BELOW_COLS) {
			const layout = [phoneHeader, phoneRule, phoneStatus, phoneRule, main(), phoneRule, liveStrip, footer];
			const sizes = allocate(rows, [2, 1, PHONE_STATUS_ROWS + 1, 1, "rest", 1, 1, 1]);
			bodyRows = Math.max(0, sizes[4] - 1);
			return layout.map((component, index) => ({ component, size: sizes[index] }));
		}
		if (cols >= THREE_COLUMNS_COLS) columns = [ITEMS_COL, Math.max(0, cols - 4 - ITEMS_COL - SIDE_COL), SIDE_COL];
		else {
			const list = Math.min(LIST_COL.max, Math.max(LIST_COL.min, Math.round(LIST_COL.share * cols)));
			columns = [Math.max(0, cols - 3 - list), list];
		}
		const statusRows = cols >= ONE_ROW_STATUS_COLS ? 1 : 2;
		const layout = [top, fHeader, divider, fStatus, open, mainRow, close, fLive, divider, fFooter, bottom];
		const sizes = allocate(rows, [1, 1, 1, statusRows, 1, "rest", 1, 1, 1, 1, 1]);
		bodyRows = Math.max(0, sizes[5] - 1);
		return layout.map((component, index) => ({ component, size: sizes[index] }));
	};
	tui.setLayoutRoot(new Stack("vstack", regions));

	// ---- Refresh loop ----
	const abort = new AbortController();
	let inflight: Promise<void> | null = null;
	let stopped = false;
	let connection: { identity: string; abort: AbortController; task: Promise<void> } | null = null;
	const attach = async () => {
		const snapshot = state.snapshot;
		if (!snapshot || stopped) return;
		if (snapshot.sources.state.status !== "fresh") {
			connection?.abort.abort();
			state.live = disconnect(state.live, "fresh loop identity unavailable");
			return;
		}
		const identity = JSON.stringify(snapshot.run);
		if (connection && connection.identity !== identity) {
			state.live = disconnect(state.live, "loop identity changed");
			connection.abort.abort();
			await connection.task;
		}
		if (connection || stopped) return;
		const controller = new AbortController();
		const session = { identity, abort: controller, task: Promise.resolve() };
		connection = session;
		session.task = (async () => {
			try {
				for await (const frame of (runtime.connectEvents ?? connectEvents)({ root, run: snapshot.run }, controller.signal)) {
					if (controller.signal.aborted || stopped) break;
					if (frame.type === "hello") matchingHello(snapshot, frame);
					if (frame.type === "event" && frame.event.kind === "fact" && (frame.event.fact.run.loopToken !== snapshot.run.loopToken || frame.event.fact.run.startedAt !== snapshot.run.startedAt)) throw new Error("Driver loop identity changed");
					state.live = applyFrame(state.live, frame);
					tui.requestRender();
				}
				if (!stopped) state.live = disconnect(state.live, "stream closed");
			} catch (error) {
				if (!stopped) state.live = disconnect(state.live, message(error));
			} finally {
				if (connection === session) connection = null;
				if (!stopped) tui.requestRender();
			}
		})();
	};
	const refresh = () => {
		// A slow read never overlaps the next one.
		if (stopped || inflight) return;
		inflight = reader.read(abort.signal).then(
			(snapshot) => { state.snapshot = snapshot; state.error = null; void attach(); loadDiff(); },
			(error: unknown) => { state.error = message(error); connection?.abort.abort(); state.live = disconnect(state.live, "snapshot unavailable"); },
		).finally(() => { inflight = null; if (!stopped) tui.requestRender(); });
	};

	// ---- Lifetime ----
	let timer: unknown = null;
	let finish!: () => void;
	let fail!: (error: unknown) => void;
	const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
	/**
	 * The one viewer lifetime boundary, for a quit and for a failed start. Each step runs even when an
	 * earlier one throws: the shared key bindings are restored and the reader is closed whatever the
	 * terminal does. Quit closes viewer resources only; the loop and enforcer keep running.
	 * Returns the terminal stop failure, if any.
	 */
	const release = async (): Promise<{ readonly error: unknown } | null> => {
		stopped = true;
		if (timer !== null) runtime.clearInterval(timer);
		abort.abort();
		state.diff?.abort.abort();
		let failure: { readonly error: unknown } | null = null;
		try {
			tui.stop();
		} catch (error) {
			failure = { error };
		}
		keybindings.setUserBindings(userBindings);
		await reader.close().catch(() => undefined);
		return failure;
	};
	const quit = async () => {
		if (stopped) return;
		stopped = true;
		// Cancel the event stream and a running read first, then wait for both to end before the terminal is released.
		abort.abort();
		connection?.abort.abort();
		await connection?.task;
		await inflight;
		// A drain failure must not skip the release.
		await terminal.drainInput(DRAIN_INPUT_MS).catch(() => undefined);
		const failure = await release();
		if (failure) fail(failure.error);
		else finish();
	};

	// ---- Keys ----
	const push = (screen: Screen) => { state.stack.push(screen); state.scroll = 0; };
	const moveSelection = (by: number) => {
		const list = state.snapshot?.items ?? [];
		const at = list.findIndex((item) => item.key === selectedKey());
		if (at < 0) return;
		state.selected = list[Math.max(0, Math.min(list.length - 1, at + by))].key;
		// The Items panel follows the selection when it draws (`itemsInView`).
		state.scroll = 0;
	};
	/** Screen keys (design spec section 7, owner Q5 on #16). Returns false for a key this screen does not use. */
	const navigate = (key: (...ids: KeyId[]) => boolean): boolean => {
		const screen = topScreen();
		// Authority: owner Q5 on #16: PgUp/PgDn scroll everywhere; ↑↓ and j k also scroll in Diff and Progress.
		const scrolls = screen.id === "diff" || screen.id === "progress";
		if (key("pageUp")) state.scroll = Math.max(0, state.scroll - Math.max(1, bodyRows - 1));
		else if (key("pageDown")) state.scroll += Math.max(1, bodyRows - 1);
		else if (key("up", "k")) { if (scrolls) state.scroll = Math.max(0, state.scroll - 1); else moveSelection(-1); }
		else if (key("down", "j")) { if (scrolls) state.scroll += 1; else moveSelection(1); }
		else if (key("escape")) { if (state.stack.length <= 1) return false; state.stack.pop(); state.scroll = 0; }
		else if (screen.id === "overview" && key("a")) push({ id: "activity" });
		else if (screen.id === "activity" && key("shift+f")) state.filter = FILTERS[(FILTERS.indexOf(state.filter) + 1) % FILTERS.length];
		else if (screen.id === "overview" && key("enter", "return")) { if (selectedKey() === null) return false; push({ id: "detail" }); }
		else if ((screen.id === "overview" || screen.id === "detail") && key("p")) push({ id: "progress" });
		else if ((screen.id === "detail" || screen.id === "progress") && key("shift+p")) { state.raw = !state.raw; state.scroll = 0; }
		else if (screen.id === "detail" && key("shift+d")) {
			const itemKey = selectedKey();
			if (itemKey === null || !state.snapshot || !itemCommits(state.snapshot, itemKey).length) return false;
			push({ id: "diff", key: itemKey, index: 0 });
		} else if (screen.id === "diff" && key("[", "]")) {
			const target = diffTarget();
			if (!target) return false;
			// `[` steps to the older commit, `]` to the newer one; the list is newest first. Wraps around.
			const step = key("[") ? 1 : -1;
			state.stack[state.stack.length - 1] = { ...screen, index: (target.index + step + target.count) % target.count };
			state.scroll = 0;
		} else return false;
		loadDiff();
		return true;
	};
	tui.addInputListener((data) => {
		// Kitty keyboard protocol terminals (herdr) also report key releases.
		if (isKeyRelease(data)) return { consume: true };
		if (stopped) return { consume: true };
		if (matchesKey(data, "ctrl+c")) {
			const now = runtime.now();
			if (state.lastCtrlCAt !== null && now - state.lastCtrlCAt <= QUIT_WINDOW_MS) void quit();
			else {
				state.lastCtrlCAt = now;
				tui.flash("Ctrl+C again to quit", QUIT_WINDOW_MS);
			}
			return { consume: true };
		}
		// matchesKey also decodes Kitty-encoded presses (ProcessTerminal enables Kitty reporting).
		const key = (...ids: KeyId[]) => ids.some((id) => matchesKey(data, id));
		if (state.confirmQuit) {
			if (key("y", "shift+y")) void quit();
			else if (key("n", "shift+n", "escape")) state.confirmQuit = false;
			else return { consume: true };
		} else if (key("shift+q")) state.confirmQuit = true;
		else if (key("q")) tui.flash("Shift+Q to quit", HINT_MS);
		else if (!navigate(key)) return undefined;
		tui.requestRender();
		return { consume: true };
	});

	try {
		keybindings.setUserBindings({ ...userBindings, "tui.altScreen.pageUp": [], "tui.altScreen.pageDown": [] });
		tui.start();
		refresh();
		timer = runtime.setInterval(refresh, REFRESH_MS);
	} catch (error) {
		// A failed start leaves no disabled bindings, open reader or alternate screen behind.
		await release();
		throw error;
	}
	return done;
}
