import { visibleWidth } from "@earendil-works/pi-tui";
import { deriveLiveness } from "../health.js";
import type { Alert, ItemStatus, LoopSnapshot, ObservedAttempt, ObservedItem } from "../types.js";
import { clean, fit, style } from "./layout.js";

/**
 * Pure Overview renderers (spec #1 architecture addition: pure core for screen rendering).
 * Each function takes a snapshot and a width and returns drawn text; none of them reads the terminal.
 */

// Authority: design spec section 3: from 150 columns the header shows tokens.
export const TOKENS_FROM_COLS = 150;
// Authority: design spec section 2 glyph vocabulary.
export const GLYPH: Record<ItemStatus, string> = {
	passed: style.green("✓"),
	working: style.accent("●"),
	retry: style.yellow("↻"),
	blocked: style.red("✕"),
	stopped: "■",
	pending: style.dim("○"),
};
// Authority: design spec section 1: solid fill with an eighth-block edge over a dense dotted track.
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;
const TRACK = "⣿";
// Authority: design spec section 3 captures: the badge column keeps three spaces before the bar.
const BADGE_GAP = 3;
// Authority: design spec section 6 card rows; the label column fits the longest label, "Not run", plus two spaces.
const CARD_LABEL_COLS = 9;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** `42s`, `18m`, `3h 12m` (design spec section 3 captures). */
export function formatDuration(ms: number): string {
	const safe = Math.max(0, ms);
	if (safe < MINUTE_MS) return `${Math.floor(safe / 1000)}s`;
	if (safe < HOUR_MS) return `${Math.floor(safe / MINUTE_MS)}m`;
	const minutes = Math.floor(safe / MINUTE_MS);
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `950`, `1.5k`, `215k`, `3.2M` (design spec section 3 capture ov-200x50). */
export function formatTokens(n: number): string {
	if (n < 1_000) return String(n);
	if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/** The one items-passed bar: `width` columns of fill, an eighth-block edge and a dim track. */
export function progressBar(passed: number, total: number, width: number): string {
	if (width <= 0 || total <= 0) return "";
	// Rounded to the nearest eighth, as in the approved captures (ov-120x40: 7/12 of 97 columns ends in ▋).
	const eighths = Math.round((Math.min(passed, total) / total) * width * 8);
	const full = Math.floor(eighths / 8);
	const edge = full < width ? EIGHTHS[eighths % 8] : "";
	const track = width - full - (edge ? 1 : 0);
	return style.accent("█".repeat(full) + edge) + style.dim(TRACK.repeat(track));
}

/** Enforcer verdict chip (design spec section 1). `commits` counts the commits the enforcer checked. */
export function enforcerChip(alerts: readonly Alert[], commits: number): string {
	const hard = alerts.filter((a) => a.level === "HARD").length;
	const warn = alerts.filter((a) => a.level === "WARN").length;
	if (hard > 0) return style.red(`✕ enforcer ${hard} hard`);
	if (warn > 0) return style.yellow(`⚠ enforcer ${warn} warn`);
	return style.green(`✓ enforcer ${commits} ${commits === 1 ? "commit" : "commits"} clean`);
}

const findItem = (snapshot: LoopSnapshot, key: string | null): ObservedItem | null =>
	key === null ? null : snapshot.items.find((item) => item.key === key) ?? null;

/** Status badge. Owner Q3 on #15: NEEDS YOU only when the stopped item is blocked. Owner D1: health through deriveLiveness. */
export function badge(snapshot: LoopSnapshot, now: number): string {
	const health = deriveLiveness(snapshot, null, now).badge;
	switch (health) {
		case "running": return style.accent("● RUNNING");
		case "stale": return style.yellow("◐ STALE");
		case "stalled": return style.yellow("◐ STALLED");
		case "stopped": {
			if (findItem(snapshot, snapshot.stoppedItem)?.status === "blocked") return style.red("■ NEEDS YOU");
			const reason = snapshot.health.stopped?.reason;
			return `■ STOPPED${reason ? ` ${clean(reason)}` : ""}`;
		}
		case "not-started": return style.dim("○ NOT STARTED");
		case "unknown": return style.yellow("STATE UNKNOWN");
	}
}

/** Join a left and a right part, the right part flush with the end of `width`. */
function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap < 1 ? fit(`${left} ${right}`, width) : `${left}${" ".repeat(gap)}${right}`;
}

/**
 * Header row. Worktree, elapsed time and cost always show; branch, model, heartbeat age and tokens
 * show in that order of priority while they fit, so a narrow frame drops them and never truncates.
 */
export function headerLine(snapshot: LoopSnapshot | null, worktree: string, width: number, cols: number): string {
	const elapsed = snapshot?.timeline.elapsed;
	const usage = snapshot?.usage;
	const branch = snapshot?.git?.branch;
	const model = snapshot?.state?.model_id;
	const hb = snapshot?.health.heartbeatAgeMs;
	const live = snapshot?.health.state === "running" || snapshot?.health.state === "stale";
	const text = {
		branch: branch ? `⎇ ${clean(branch)}` : null,
		model: model ? style.dim(clean(model)) : null,
		hb: live && hb !== null && hb !== undefined ? `hb ${formatDuration(hb)}` : null,
		tokens: usage && cols >= TOKENS_FROM_COLS ? `In ${formatTokens(usage.input)} · Cached ${formatTokens(usage.cacheRead)} · Out ${formatTokens(usage.output)}` : null,
	};
	const shown = new Set<keyof typeof text>();
	const draw = () => {
		const left = [` ${style.accent("◆")} ${style.bold("Ralph Watch")}`, worktree, shown.has("branch") ? text.branch : null, shown.has("model") ? text.model : null];
		const right = [shown.has("hb") ? text.hb : null, elapsed ? `Time ${formatDuration(elapsed.wallMs)}` : null, shown.has("tokens") ? text.tokens : null, usage ? `$${usage.costUsd.toFixed(2)}` : null];
		const r = right.filter((part): part is string => part !== null).join(" · ");
		return [left.filter((part): part is string => part !== null).join("  "), r ? `${r} ` : ""] as const;
	};
	for (const name of ["branch", "model", "hb", "tokens"] as const) {
		if (text[name] === null) continue;
		shown.add(name);
		const [a, b] = draw();
		if (visibleWidth(a) + 2 + visibleWidth(b) > width) shown.delete(name);
	}
	const [a, b] = draw();
	return spread(a, b, width);
}

type StatusParts = { badge: string; bar: ((width: number) => string) | null; count: string | null; iteration: string | null; left: string | null; eta: string | null };

function statusParts(snapshot: LoopSnapshot, now: number): StatusParts {
	const total = snapshot.items.length;
	const passed = snapshot.items.filter((item) => item.passes).length;
	const state = snapshot.state;
	const itemsLeft = snapshot.timeline.eta.itemsLeft;
	let left: string | null = null;
	let eta: string | null = null;
	if (total > 0 && itemsLeft > 0) {
		// Authority: spec #1 story 21 and design spec section 1: warn when items left exceed iterations left.
		const risk = state !== null && itemsLeft > state.max_iterations - state.iteration;
		const text = `${plural(itemsLeft, "item")} left`;
		left = risk ? style.yellow(`⚠ ${text}`) : text;
		// Authority: spec #1 stories 19 and 20: an estimate with its sample count, "n/a" until one item finished.
		const estimate = snapshot.timeline.eta.estimateMs;
		eta = estimate === null ? "ETA n/a" : `ETA ~${formatDuration(estimate)} n=${snapshot.timeline.eta.n}`;
	}
	return {
		badge: badge(snapshot, now),
		bar: total > 0 ? (width) => progressBar(passed, total, width) : null,
		count: total > 0 ? `${passed}/${total}` : null,
		iteration: state ? `iteration ${state.iteration}/${state.max_iterations}` : null,
		left, eta,
	};
}

/**
 * Status rows for the desktop frame (design spec section 3): one row from 150 columns, else two
 * (bar and count; then iteration, items left, ETA and the chip). `chip` is null until persisted alerts exist (owner Q1 on #15).
 */
export function statusRows(snapshot: LoopSnapshot | null, width: number, rows: 1 | 2, now: number, error: string | null, chip: string | null = null): string[] {
	const failure = error === null ? null : style.red(`✕ refresh failed: ${clean(error)}`);
	if (!snapshot) return [` ${failure ?? style.dim("reading loop state…")}`];
	const p = statusParts(snapshot, now);
	const lead = ` ${p.badge}${" ".repeat(BADGE_GAP)}`;
	const indent = " ".repeat(visibleWidth(lead));
	const tail = (parts: readonly (string | null)[]) => parts.filter((part): part is string => part !== null);
	const withBar = (before: string, after: string) => {
		if (!p.bar) return `${before.trimEnd()}${after ? `   ${after.trimStart()}` : ""}`;
		return `${before}${p.bar(Math.max(0, width - visibleWidth(before) - visibleWidth(after)))}${after}`;
	};
	if (rows === 1) {
		const after = [`  ${p.count ?? ""}`, ...tail([p.eta]).map((x) => `  ${x}`), ...tail([p.iteration]).map((x) => `   ${x}`), ...tail([p.left]).map((x) => `  ${x}`), ...tail([failure, chip]).map((x) => `   ${x}`)].join("");
		return [withBar(lead, p.bar ? `${after}  ` : after.trim())];
	}
	const first = withBar(lead, p.bar ? `  ${p.count}  ${failure ? `${failure}  ` : ""}` : failure ?? "");
	const second = tail([p.iteration, p.left, p.eta]).join("  ");
	return [first, spread(`${indent}${second}`, chip ? `${chip}  ` : "", width)];
}

/** Phone status block (design spec section 4): badge, bar with count, then iteration · items left · ETA. */
export function phoneStatusRows(snapshot: LoopSnapshot | null, width: number, now: number, error: string | null): string[] {
	const failure = error === null ? null : style.red(`✕ refresh failed: ${clean(error)}`);
	if (!snapshot) return [` ${failure ?? style.dim("reading loop state…")}`];
	const p = statusParts(snapshot, now);
	const rows = [` ${p.badge}${failure ? `   ${failure}` : ""}`];
	if (p.bar && p.count) rows.push(` ${p.bar(Math.max(0, width - 1 - 2 - visibleWidth(p.count) - 1))}  ${p.count}`);
	const facts = [p.iteration, p.left, p.eta].filter((part): part is string => part !== null);
	if (facts.length) rows.push(` ${facts.join(" · ")}`);
	return rows;
}

const label = (item: ObservedItem) => clean(`${item.id ?? item.key} ${item.title}`);

function itemMs(snapshot: LoopSnapshot, key: string): number | null {
	const current = snapshot.timeline.currentItem;
	if (current?.key === key && current.ms !== null) return current.ms;
	const duration = snapshot.timeline.durations[key];
	return duration && duration.ms !== null ? duration.ms : null;
}

/** Items panel title with the passed count flush right. */
export function itemsTitle(snapshot: LoopSnapshot | null, width: number): string {
	const list = snapshot?.items ?? [];
	return spread(style.bold("Items"), list.length ? `${list.filter((item) => item.passes).length}/${list.length}` : "", width);
}

/** One row per item: glyph, id, title and its measured duration flush right. */
export function itemRows(snapshot: LoopSnapshot | null, width: number): string[] {
	return (snapshot?.items ?? []).map((item) => {
		const ms = itemMs(snapshot!, item.key);
		const text = `${GLYPH[item.status]} ${label(item)}`;
		if (ms === null) return text;
		const time = formatDuration(ms);
		return `${fit(text, Math.max(0, width - time.length - 1))} ${time}`;
	});
}

const currentKey = (snapshot: LoopSnapshot) => snapshot.currentItem ?? snapshot.stoppedItem;

/** Current item panel title: status glyph, id and title. */
export function currentTitle(snapshot: LoopSnapshot | null): string {
	const item = snapshot ? findItem(snapshot, currentKey(snapshot)) : null;
	if (!item) return style.bold("Current item");
	return `${GLYPH[item.status]} ${style.bold("Current item")} ${clean(item.id ?? item.key)}  ${clean(item.title)}`;
}

/** Word-wrap clean text to `width` columns; a word longer than a row is cut. */
function wrap(text: string, width: number): string[] {
	if (width <= 0) return [];
	const rows: string[] = [];
	let row = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const next = row ? `${row} ${word}` : word;
		if (visibleWidth(next) <= width) { row = next; continue; }
		if (row) rows.push(row);
		row = visibleWidth(word) <= width ? word : fit(word, width);
	}
	if (row) rows.push(row);
	return rows;
}

/** A labelled card row: the label column, then text wrapped under itself. */
function cardRow(name: string, text: string, width: number): string[] {
	const pad = " ".repeat(CARD_LABEL_COLS);
	return wrap(clean(text), width - CARD_LABEL_COLS).map((line, index) => `${index === 0 ? style.dim(name.padEnd(CARD_LABEL_COLS)) : pad}${line}`);
}

const short = (sha: string) => sha.slice(0, 7);

/** One progress attempt card (design spec section 6). Raw entry text is never drawn here. */
export function attemptCard(card: ObservedAttempt, width: number): string[] {
	const glyph = card.outcome === "blocked" ? style.red("✕ blocked") : card.outcome === "passed" ? style.green("✓ passed") : null;
	const head = [glyph, clean(card.title)].filter((part): part is string => part !== null).join("  ");
	const rows = [spread(head, card.date ? clean(card.date) : "", width)];
	const f = card.fields;
	if (card.outcome === "blocked" && card.resolvedBy !== null) {
		// A resolved blocker collapses to Resolved and Asked.
		rows.push(...cardRow("Resolved", card.resolvedCommitSha ? short(card.resolvedCommitSha) : `entry ${card.resolvedBy + 1}`, width));
		if (f?.decide) rows.push(...cardRow("Asked", f.decide, width));
		return rows;
	}
	if (!f) return rows;
	if (f.failed) {
		rows.push(...cardRow("Failed", `${f.failed.cmd}${f.failed.exit !== null ? `  exit ${f.failed.exit}` : ""}`, width));
		if (f.failed.error) rows.push(...cardRow("", f.failed.error, width));
	}
	if (f.cause) rows.push(...cardRow("Cause", f.cause, width));
	if (f.tried) rows.push(...cardRow("Tried", f.tried, width));
	if (f.decide) rows.push(...cardRow("Decide", f.decide, width));
	if (f.proof) rows.push(...cardRow("Proof", `${f.proof.identical}/${f.proof.total} identical`, width));
	if (f.checks.length) {
		// Collapsed checks: a count when all ended green; otherwise only the red finals.
		const red = f.checks.filter((check) => check.exits.at(-1) !== 0);
		rows.push(...cardRow("Checks", red.length ? red.map((check) => `✕ ${check.cmd}`).join("  ") : `✓ ${f.checks.length}`, width));
	}
	const changed = f.counts.filter((count) => count.from !== count.to);
	if (changed.length) rows.push(...cardRow("Counts", changed.map((count) => `${count.label} ${count.from}→${count.to}`).join("  "), width));
	if (f.diff) rows.push(...cardRow("Diff", f.diff, width));
	if (f.assumed.length) rows.push(...cardRow("Assumed", f.assumed.join("; "), width));
	if (f.notRun.length) rows.push(...cardRow("Not run", f.notRun.join(" · "), width));
	if (f.evidence.length) rows.push(...cardRow("Evidence", f.evidence.join("; "), width));
	return rows;
}

/**
 * Current item body: category · runs · blockers · time on item; an unresolved blocker card first;
 * the steps; then the other attempt cards newest first (spec #1 stories 29, 38, 39; design spec section 3).
 */
export function currentBody(snapshot: LoopSnapshot | null, width: number): string[] {
	if (!snapshot) return [];
	const key = currentKey(snapshot);
	const item = findItem(snapshot, key);
	if (!item || key === null) return [];
	const bundle = snapshot.mission?.bundle ?? null;
	const index = bundle ? bundle.itemKeys.indexOf(key) : -1;
	const meta = index >= 0 && bundle ? bundle.items.items[index] : null;

	const facts: string[] = [];
	if (meta?.category) facts.push(clean(meta.category));
	// Runs on this item: the run in which it became current, plus every later run start.
	const since = [...snapshot.timeline.boundaries].filter((b) => b.kind === "item-pass").map((b) => Date.parse(b.at)).sort((a, b) => a - b).at(-1);
	const starts = snapshot.runStarts.map((r) => Date.parse(r.startedAt));
	const runs = since === undefined ? starts.length : 1 + starts.filter((at) => at > since).length;
	if (runs > 0) facts.push(plural(runs, "run"));
	const blockers = (snapshot.git?.commits ?? []).filter((c) => c.kind === "blocker" && c.blockerItem === key).length;
	if (blockers > 0) facts.push(plural(blockers, "blocker"));
	const current = snapshot.timeline.currentItem;
	if (current?.key === key && current.ms !== null) facts.push(`${formatDuration(current.ms)} on item`);

	const rows: string[] = [];
	const section = (lines: readonly string[]) => { if (lines.length) rows.push("", ...lines); };
	if (facts.length) rows.push(style.dim(facts.join(" · ")));
	const attempts = snapshot.itemAttempts[key] ?? [];
	const open = attempts.filter((a) => a.outcome === "blocked" && a.resolvedBy === null);
	for (const card of open) section(attemptCard(card, width));
	const steps = meta?.steps ?? [];
	if (steps.length) section([style.bold("Steps"), ...steps.flatMap((step, i) => wrap(`${i + 1} ${clean(step)}`, width))]);
	for (const card of attempts.filter((a) => !open.includes(a))) section(attemptCard(card, width));
	return rows.length && rows[0] === "" ? rows.slice(1) : rows;
}

/** Iterations column at 170+ columns: run and iteration count only (owner Q5 on #15). */
export function iterationsTitle(snapshot: LoopSnapshot | null, width: number): string {
	const runs = snapshot?.runStarts.length ?? 0;
	return spread(style.bold("Iterations"), runs > 0 ? `run ${runs}` : "", width);
}

export function iterationsBody(snapshot: LoopSnapshot | null): string[] {
	const state = snapshot?.state;
	return state ? [`iteration ${state.iteration}/${state.max_iterations}`] : [];
}
