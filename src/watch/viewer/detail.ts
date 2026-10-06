import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isSourcePath } from "../content.js";
import type { Alert, CommitEvent, FileChange, LoopSnapshot, ObservedAttempt, SeamEvidence } from "../types.js";
import { clean, style } from "./layout.js";
import { attemptCard, findItem, formatDuration, GLYPH, itemMs, short, spread, wrap } from "./overview.js";

/**
 * Pure Item detail renderers (design spec section 5: status line, attempt cards newest first,
 * commits with files and enforcer finding, steps and gates). None of them reads the terminal.
 */

const STATUS_WORD = { passed: "passed", working: "working", retry: "retry after blocker", blocked: "blocked", stopped: "loop stopped", pending: "pending" } as const;
const KIND_WORD: Record<CommitEvent["kind"], string> = { "item-pass": "pass", blocker: "blocker", parent: "parent", other: "commit" };
// Loop bookkeeping files are not item edits (the enforcer scope rule skips them too).
const RALPH_DIR = ".ralph/";

/**
 * The item that was current just before each commit (spec #1 story 26: the first item with
 * `passes: false`), replayed from fresh commit evidence. A seam that edits `.ralph/items.json`
 * records the pending items before it (`policy.items.beforePending`). A seam that leaves the file
 * alone has the same item state before and after, so it takes the state of the next seam; after
 * the last commit come the index and worktree seams, then the fresh items file itself. Unknown
 * (`undefined`) wherever that chain has a gap: nothing is guessed. Null means no item was pending.
 */
function currentBefore(snapshot: LoopSnapshot, commits: readonly CommitEvent[]): readonly (string | null | undefined)[] {
	const evidence = snapshot.evidence;
	if (snapshot.mission?.task.kind !== "bundle" || !evidence) return commits.map(() => undefined);
	const seams = [...commits.map((c) => evidence.commits[c.sha]), evidence.index, evidence.worktree];
	let next: string | null | undefined = snapshot.sources.items.status === "fresh" ? snapshot.items.find((item) => !item.passes)?.key ?? null : undefined;
	const before: (string | null | undefined)[] = [];
	for (let i = seams.length - 1; i >= 0; i--) {
		const seam = seams[i];
		const items = seam?.status === "fresh" ? seam.policy.items : undefined;
		if (items === null) before[i] = next;
		else if (items && "beforePending" in items) before[i] = items.beforePending[0] ?? null;
		else before[i] = undefined;
		next = before[i];
	}
	return before.slice(0, commits.length);
}

/**
 * The commits of one item, newest first: its pass commits, its blocker commits, and approved parent
 * commits made while it was the current item (`currentBefore`). Only fresh history: an empty list
 * when git or history is not fresh.
 */
export function itemCommits(snapshot: LoopSnapshot, key: string): readonly CommitEvent[] {
	const commits = snapshot.git?.commits;
	if (!commits) return [];
	const current = currentBefore(snapshot, commits);
	return commits
		.filter((c, i) => c.passedItems.includes(key) || (c.kind === "blocker" && c.blockerItem === key) || (c.kind === "parent" && current[i] === key))
		.reverse();
}

export type Proof =
	| { readonly state: "passed"; readonly sha: string }
	| { readonly state: "stale"; readonly sha: string; readonly path: string; readonly where: string }
	| { readonly state: "unknown" };

const UNKNOWN: Proof = { state: "unknown" };

/**
 * Proof state of a passed item (owner Q1 `pass-commit-proof` and Q2 `scope-then-source` on #16).
 * Stale only when fresh evidence shows a later edit to a relevant path: the item scope paths
 * (`allowedPaths`, `targets`), else configured source discovery. Any missing piece is unknown.
 */
export function proofState(snapshot: LoopSnapshot, key: string): Proof {
	const mission = snapshot.mission;
	const commits = snapshot.git?.commits;
	const evidence = snapshot.evidence;
	if (!mission || !commits || !evidence || !findItem(snapshot, key)?.passes) return UNKNOWN;
	let passAt = -1;
	for (let i = 0; i < commits.length; i++) if (commits[i].passedItems.includes(key)) passAt = i;
	if (passAt < 0) return UNKNOWN;
	// A later commit with unknown passes may hide an unpass and a re-pass of this item.
	if (commits.slice(passAt + 1).some((c) => !c.passesKnown)) return UNKNOWN;
	const scope = mission.scope.items.find((s) => s.id === key);
	const scopePaths = scope ? [...scope.allowedPaths, ...scope.targets] : null;
	const sourceDiscovery = mission.scope.sourceGlobs.length > 0 || mission.scope.sourceRegex !== null;
	if (!scopePaths && !sourceDiscovery) return UNKNOWN;
	const relevant = (file: string) => !file.startsWith(RALPH_DIR) && (scopePaths
		? scopePaths.some((allowed) => allowed === "." || file === allowed || file.startsWith(`${allowed}/`))
		: isSourcePath(mission, file));
	const sha = commits[passAt].sha;
	const seams: [string, SeamEvidence | undefined][] = [
		...commits.slice(passAt + 1).map((c): [string, SeamEvidence | undefined] => [short(c.sha), evidence.commits[c.sha]]),
		["index", evidence.index],
		["worktree", evidence.worktree],
	];
	let missing = false;
	for (const [where, seam] of seams) {
		if (seam?.status !== "fresh") { missing = true; continue; }
		const hit = seam.changes.find((change: FileChange) => relevant(change.path));
		if (hit) return { state: "stale", sha, path: hit.path, where };
	}
	return missing ? UNKNOWN : { state: "passed", sha };
}

function proofLine(proof: Proof): string {
	switch (proof.state) {
		case "passed": return `${style.green("✓")} passed at ${short(proof.sha)}`;
		case "stale": return style.yellow(`◌ stale: ${clean(proof.path)} edited in ${proof.where} after ${short(proof.sha)}`);
		case "unknown": return style.dim("○ proof unknown");
	}
}

/** Detail title: status glyph, id and title. */
export function detailTitle(snapshot: LoopSnapshot | null, key: string | null): string {
	const item = snapshot ? findItem(snapshot, key) : null;
	if (!item) return style.bold("Item");
	return `${GLYPH[item.status]} ${style.bold(clean(item.id ?? item.key))}  ${clean(item.title)}`;
}

/** The raw progress entry, sanitized line by line (newlines kept as rows) and wrapped to `width`. */
export function rawRows(card: ObservedAttempt, width: number): string[] {
	if (width <= 0) return [];
	const lines = card.raw.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").map((line) => clean(line));
	return lines.flatMap((line) => (line.trim() ? wrapTextWithAnsi(line, width) : [""]));
}

const levelGlyph = (alert: Alert) => (alert.level === "HARD" ? style.red(`✕ ${clean(alert.rule)}`) : alert.level === "WARN" ? style.yellow(`⚠ ${clean(alert.rule)}`) : style.dim(clean(alert.rule)));

/**
 * Detail body. `alerts` is null until persisted enforcer alerts reach the snapshot (T12); then each
 * commit shows its findings. `raw` replaces only the attempt cards with the raw entries.
 */
export function detailBody(snapshot: LoopSnapshot | null, key: string | null, width: number, options: { readonly raw: boolean; readonly alerts: readonly Alert[] | null }): string[] {
	if (!snapshot || key === null) return [];
	const item = findItem(snapshot, key);
	if (!item) return [];
	const bundle = snapshot.mission?.bundle ?? null;
	const index = bundle ? bundle.itemKeys.indexOf(key) : -1;
	const meta = index >= 0 && bundle ? bundle.items.items[index] : null;
	const commits = itemCommits(snapshot, key);

	const facts = [`${GLYPH[item.status]} ${STATUS_WORD[item.status]}`];
	const ms = itemMs(snapshot, key);
	if (ms !== null) facts.push(formatDuration(ms));
	const blockers = commits.filter((c) => c.kind === "blocker").length;
	if (blockers > 0) facts.push(`${blockers} blocker${blockers === 1 ? "" : "s"}`);
	if (meta?.category) facts.push(clean(meta.category));

	const rows: string[] = [facts.join(" · ")];
	const section = (lines: readonly string[]) => { if (lines.length) rows.push("", ...lines); };
	for (const card of snapshot.itemAttempts[key] ?? []) section(options.raw ? rawRows(card, width) : attemptCard(card, width));

	if (commits.length) {
		const lines = [style.bold("Commits")];
		for (const commit of commits) {
			const age = commit.committedAt ? clean(commit.committedAt.slice(0, 16).replace("T", " ")) : "";
			lines.push(spread(`${style.accent(short(commit.sha))} ${style.dim(KIND_WORD[commit.kind])} ${clean(commit.subject)}`, style.dim(age), width));
			const seam = snapshot.evidence?.commits[commit.sha];
			if (seam?.status === "fresh") for (const change of seam.changes) lines.push(`  ${style.dim(change.status)} ${clean(change.path)}`);
			for (const alert of options.alerts?.filter((a) => a.commit === commit.sha) ?? []) lines.push(`  ${levelGlyph(alert)}`);
		}
		section(lines);
	}
	const steps = meta?.steps ?? [];
	if (steps.length) section([style.bold("Steps"), ...steps.flatMap((step, i) => wrap(`${i + 1} ${clean(step)}`, width))]);
	const gates = bundle?.items.runtime_contract?.verification_gates ?? [];
	if (gates.length) {
		// Owner Q1 on #16: one proof state per item; an item that has not passed has no accepted proof: unknown.
		const proof = proofLine(item.passes ? proofState(snapshot, key) : UNKNOWN);
		section([spread(style.bold("Gates"), proof, width), ...gates.map((gate) => `${clean(gate.name)}  ${style.dim(clean(gate.command))}`)]);
	}
	return rows;
}
