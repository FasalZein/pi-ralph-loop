import path from "node:path";
import { type Component, isKeyRelease, matchesKey, ProcessTerminal, type Terminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { openLoop } from "./loop-state.js";
import type { ItemStatus, LoopReader, LoopSnapshot } from "./types.js";
import { allocate, clean, Lines, message, Panel, type Region, splitExact, spread, Stack, style } from "./viewer/layout.js";

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
// Authority: design spec section 3 diagram: current item 50 and item list 26 inner columns at 80 columns.
const MAIN_SPLIT = [50, 26] as const;
// Authority: pi interactive mode drains Kitty key releases for up to 1 s before it stops the terminal.
const DRAIN_INPUT_MS = 1_000;

export type ViewerRuntime = {
	readonly terminal: Terminal;
	readonly now: () => number;
	readonly setInterval: (fn: () => void, ms: number) => unknown;
	readonly clearInterval: (handle: unknown) => void;
	readonly openLoop: (root: string) => LoopReader;
};

const defaultRuntime = (): ViewerRuntime => ({
	terminal: new ProcessTerminal(),
	now: Date.now,
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
	openLoop: (root) => openLoop(root),
});

/** Mutable viewer state. Snapshots stay immutable and are only replaced. */
type ViewerState = {
	snapshot: LoopSnapshot | null;
	/** The last refresh failure; cleared by the next successful read. */
	error: string | null;
	confirmQuit: boolean;
	lastCtrlCAt: number | null;
};

const GLYPH: Record<ItemStatus, string> = {
	passed: style.green("✓"),
	working: style.accent("●"),
	retry: style.yellow("↻"),
	blocked: style.red("✕"),
	stopped: "■",
	pending: style.dim("○"),
};

function badge(snapshot: LoopSnapshot): string {
	const health = snapshot.health;
	switch (health.state) {
		case "running": return style.accent("● RUNNING");
		case "stale": return style.yellow("◐ STALE");
		case "stopped": return `■ STOPPED${health.stopped?.reason ? ` ${clean(health.stopped.reason)}` : ""}`;
		case "not-started": return style.dim("○ NOT STARTED");
		case "unknown": return style.yellow("STATE UNKNOWN");
	}
}

const itemLabel = (snapshot: LoopSnapshot, key: string | null): string | null => {
	if (key === null) return null;
	const item = snapshot.items.find((candidate) => candidate.key === key);
	return item ? clean(`${item.id ?? item.key} ${item.title}`) : clean(key);
};

/** The standalone Ralph Watch viewer. Resolves after a deliberate quit; never exits the process. */
export async function runViewer(spec: { readonly roots: readonly string[]; readonly initialRoot?: string }, runtime: ViewerRuntime = defaultRuntime()): Promise<void> {
	const root = spec.initialRoot ?? spec.roots[0];
	if (!root) throw new Error("ralph watch needs a loop root");
	// Fails before the alternate screen opens, so a bad root prints a plain error.
	const reader = runtime.openLoop(root);
	const { terminal } = runtime;
	const state: ViewerState = { snapshot: null, error: null, confirmQuit: false, lastCtrlCAt: null };
	const tui = new TuiAltScreen(terminal, false);

	// ---- Regions ----
	const worktree = clean(path.basename(root));
	const branch = () => state.snapshot?.git?.branch ? clean(state.snapshot.git.branch) : null;
	const statusLine = (): string => {
		const parts: string[] = [];
		const snapshot = state.snapshot;
		if (snapshot) {
			parts.push(badge(snapshot));
			if (snapshot.items.length > 0) parts.push(`${snapshot.items.filter((item) => item.passes).length}/${snapshot.items.length} items`);
		} else if (!state.error) parts.push(style.dim("reading loop state…"));
		if (state.error) parts.push(style.red(`✕ refresh failed: ${clean(state.error)}`));
		return parts.join("   ");
	};
	const header = new Lines(() => [` ${style.accent("◆")} ${style.bold("Ralph Watch")}  ${worktree}${branch() ? `  ⎇ ${branch()}` : ""}`], "header");
	const phoneHeader = new Lines(() => [` ${style.accent("◆")} ${style.bold("Ralph Watch")}`, ` ${worktree}${branch() ? ` · ${branch()}` : ""}`], "header");
	const status = new Lines(() => [` ${statusLine()}`], "status");
	const footer = new Lines(() => [state.confirmQuit
		? ` Quit Ralph Watch? The loop keeps running.   ${style.bold("y")} quit   ${style.bold("n")} stay`
		: ` ${style.bold("⇧Q")} Quit`], "footer");
	const current = new Panel(() => style.bold("Current item"), () => {
		const snapshot = state.snapshot;
		if (!snapshot) return [];
		const running = itemLabel(snapshot, snapshot.currentItem);
		if (running) return [`${style.accent("●")} ${running}`];
		const stopped = itemLabel(snapshot, snapshot.stoppedItem);
		return stopped ? [`■ ${stopped}`] : [];
	}, "Current item");
	const items = new Panel(() => {
		const list = state.snapshot?.items ?? [];
		return `${style.bold("Items")}${list.length ? style.dim(`  ${list.filter((item) => item.passes).length}/${list.length}`) : ""}`;
	}, () => (state.snapshot?.items ?? []).map((item) => `${GLYPH[item.status]} ${clean(`${item.id ?? item.key} ${item.title}`)}`), "Items");

	// ---- Frame (Look A on desktop, rules only on phones) ----
	let split: readonly number[] = [0, 0];
	const rule = (left: string, fill: string, right: string, junction?: string) => new Lines((width) => {
		const inner = Math.max(0, width - 2);
		const body = junction ? `${fill.repeat(split[0])}${junction}${fill.repeat(Math.max(0, inner - split[0] - 1))}` : fill.repeat(inner);
		return [style.dim(`${left}${body}${right}`)];
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
	const [fHeader, fStatus, fFooter] = [header, status, footer].map(framed);
	const mainRow = new Stack("hstack", () => [
		{ component: vrule, size: 1 }, { component: current, size: split[0] },
		{ component: vrule, size: 1 }, { component: items, size: split[1] },
		{ component: vrule, size: 1 },
	]);

	const regions = (): Region[] => {
		const cols = terminal.columns;
		const rows = terminal.rows;
		if (cols < PHONE_BELOW_COLS) {
			const layout = [phoneHeader, phoneRule, status, phoneRule, current, phoneRule, footer];
			const sizes = allocate(rows, [2, 1, PHONE_STATUS_ROWS, 1, "rest", 1, 1]);
			return layout.map((component, index) => ({ component, size: sizes[index] }));
		}
		split = splitExact(cols - 3, MAIN_SPLIT);
		const statusRows = cols >= ONE_ROW_STATUS_COLS ? 1 : 2;
		const layout = [top, fHeader, divider, fStatus, open, mainRow, close, fFooter, bottom];
		const sizes = allocate(rows, [1, 1, 1, statusRows, 1, "rest", 1, 1, 1]);
		return layout.map((component, index) => ({ component, size: sizes[index] }));
	};
	tui.setLayoutRoot(new Stack("vstack", regions));

	// ---- Refresh loop ----
	const abort = new AbortController();
	let inflight: Promise<void> | null = null;
	let stopped = false;
	const refresh = () => {
		// A slow read never overlaps the next one.
		if (stopped || inflight) return;
		inflight = reader.read(abort.signal).then(
			(snapshot) => { state.snapshot = snapshot; state.error = null; },
			(error: unknown) => { state.error = message(error); },
		).finally(() => { inflight = null; if (!stopped) tui.requestRender(); });
	};

	// ---- Keys ----
	let finish!: () => void;
	const done = new Promise<void>((resolve) => { finish = resolve; });
	const quit = async () => {
		if (stopped) return;
		stopped = true;
		runtime.clearInterval(timer);
		abort.abort();
		try {
			await terminal.drainInput(DRAIN_INPUT_MS);
		} finally {
			tui.stop();
			// Quit closes viewer resources only; the loop and enforcer keep running.
			await reader.close().catch(() => undefined);
			finish();
		}
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
		if (state.confirmQuit) {
			if (data === "y" || data === "Y") void quit();
			else if (data === "n" || data === "N" || matchesKey(data, "escape")) state.confirmQuit = false;
			else return { consume: true };
		} else if (data === "Q") state.confirmQuit = true;
		else if (data === "q") tui.flash("Shift+Q to quit", HINT_MS);
		else return undefined;
		tui.requestRender();
		return { consume: true };
	});

	tui.start();
	refresh();
	const timer = runtime.setInterval(refresh, REFRESH_MS);
	return done;
}
