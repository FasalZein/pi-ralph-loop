import { isJsTs, isTestPath } from "./content.js";
import type { Alert, CommitEvent, FileChange, LaunchBaseline, LoopSnapshot, Mission } from "./types.js";

/** Injection cases 6-9 (spec #1): suppression tokens, matched inside JS/TS comment tokens only. */
export const SUPPRESSION_TOKENS: readonly string[] = ["oxlint-disable", "eslint-disable", "@ts-ignore", "@ts-expect-error"];
/** Injection cases 10-11 (spec #1): a `.skip(` or `.only(` call in test code, never in a string or comment. */
const FOCUS_CALLS = /\.\s*(skip|only)\s*\(/g;

const CONTENT_RULES = ["suppression-comment", "test-focus", "deleted-test"] as const;
const HISTORY_RULES = ["nonlinear-history", ...CONTENT_RULES] as const;
const GENERIC_RULES = ["branch-changed", "base-not-ancestor", ...HISTORY_RULES] as const;
type GenericRule = (typeof GENERIC_RULES)[number];

const branchName = (branch: string | null) => branch === null ? "(detached HEAD)" : JSON.stringify(branch);

/**
 * Pure generic-rule evaluation over one snapshot. History guards come first,
 * then every commit in base..HEAD oldest first against its first parent, then
 * the index and the worktree. Only fresh evidence is read: an observation with
 * any concurrent-change issue gives one `observation-retry` WARN and a missing section gives a
 * `coverage-incomplete` WARN, never silence. `launch` is the branch captured at
 * launch; it is the baseline when the mission sets no branch.
 */
export function evaluate(snapshot: LoopSnapshot, mission: Mission, launch: LaunchBaseline | null): readonly Alert[] {
	const alerts = new Map<string, Alert>();
	const emit = (rule: string, level: Alert["level"], item: string | null, commit: string | null, evidence: readonly string[]) => {
		const key = JSON.stringify([rule, level, item, commit, evidence]);
		if (!alerts.has(key)) alerts.set(key, { timestamp: snapshot.observedAt, level, rule, item, commit, evidence, run: snapshot.run });
	};
	const level = (rule: GenericRule): Alert["level"] | null => {
		const configured = mission.rules[rule];
		return configured === "hard" ? "HARD" : configured === "warn" ? "WARN" : null;
	};
	const raise = (rule: GenericRule, item: string | null, commit: string | null, evidence: readonly string[]) => {
		const found = level(rule);
		if (found) emit(rule, found, item, commit, evidence);
	};
	// Owner decision on #11 (2026-10-01): coverage-incomplete and observation-retry are WARN.
	const incomplete = (section: string, rules: readonly GenericRule[], cause: string, commit: string | null = null) => {
		const enabled = rules.filter((rule) => level(rule) !== null);
		if (enabled.length) emit("coverage-incomplete", "WARN", null, commit, [`${section}: ${cause}`, `rules not checked: ${enabled.join(", ")}`]);
	};

	// Any source that changed during the read makes the whole observation torn,
	// including its run key: retry, never a finding.
	const torn = snapshot.issues.filter((issue) => issue.kind === "concurrent");
	if (torn.length) {
		emit("observation-retry", "WARN", null, null, torn.map((issue) => `${issue.source}: ${issue.detail}`));
		return [...alerts.values()];
	}
	const git = snapshot.git;
	const evidence = snapshot.evidence;
	if (!git || !evidence) {
		incomplete("git", GENERIC_RULES, snapshot.sources.git.error ?? "git unavailable");
		return [...alerts.values()];
	}

	const expected = mission.git.branch ?? (launch ? launch.branch : undefined);
	if (expected === undefined) incomplete("branch", ["branch-changed"], "no mission branch and no launch-captured branch");
	else if (git.branch !== expected) raise("branch-changed", null, git.head, [`expected branch ${branchName(expected)}`, `observed branch ${branchName(git.branch)}`]);

	if (git.base !== mission.git.baseCommit) {
		incomplete("history", ["base-not-ancestor", ...HISTORY_RULES], `observed base ${git.base ?? "(none)"} is not the mission base ${mission.git.baseCommit}`);
	} else {
		if (evidence.baseAncestor === false) raise("base-not-ancestor", null, git.head, [`base ${git.base} is not an ancestor of HEAD ${git.head}`]);
		else if (evidence.baseAncestor === null) incomplete("ancestry", ["base-not-ancestor"], snapshot.sources.history.error ?? "ancestry unknown");
		if (!git.commits) incomplete("history", HISTORY_RULES, snapshot.sources.history.error ?? "history unavailable");
		for (const commit of git.commits ?? []) {
			if (commit.parents.length > 1) raise("nonlinear-history", null, commit.sha, [`merge commit ${commit.sha} has ${commit.parents.length} parents`, commit.subject]);
			const seam = evidence.commits[commit.sha];
			if (!seam || seam.status !== "fresh") incomplete(`commit ${commit.sha}`, CONTENT_RULES, seam?.error ?? "no content evidence", commit.sha);
			else check(seam.changes, `commit ${commit.sha}`, commit.sha, commitItem(commit));
		}
	}

	for (const [name, seam] of [["index", evidence.index], ["worktree", evidence.worktree]] as const) {
		if (seam.status !== "fresh") incomplete(name, CONTENT_RULES, seam.error);
		else check(seam.changes, name, null, snapshot.currentItem);
	}
	return [...alerts.values()];

	function check(changes: readonly FileChange[], seam: string, commit: string | null, item: string | null): void {
		for (const change of changes) {
			const file = JSON.stringify(change.path);
			const test = isTestPath(mission, change.path);
			if (change.status === "D") {
				// Size is irrelevant: an empty test file deleted is still a deleted test.
				if (test) raise("deleted-test", item, commit, [`${seam}: deleted test ${file}`]);
				continue;
			}
			const suppression = isJsTs(change.path) && level("suppression-comment") !== null;
			const focus = test && level("test-focus") !== null;
			if (!suppression && !focus) continue;
			if (change.content.kind !== "lines") {
				const rules: GenericRule[] = [...(suppression ? ["suppression-comment" as const] : []), ...(focus ? ["test-focus" as const] : [])];
				incomplete(`${seam} ${file}`, rules, change.content.kind === "unavailable" ? change.content.reason : "content not collected", commit);
				continue;
			}
			const { lines, added, lexed } = change.content;
			const isAdded = new Set(added);
			const unclassified = (rule: GenericRule, line: number, what: string, reason: string) =>
				emit("coverage-incomplete", "WARN", item, commit, [`${seam}: ${file}:${line}: ${what} ${reason}`, `rules not checked: ${rule}`]);
			if (suppression && lexed) {
				for (const n of added) {
					const raw = lines[n - 1];
					const { comment, unsure } = lexed[n - 1];
					for (const token of SUPPRESSION_TOKENS) {
						for (let at = raw.indexOf(token); at >= 0; at = raw.indexOf(token, at + 1)) {
							if (unsure.slice(at, at + token.length).includes("?")) unclassified("suppression-comment", n, token, "in syntax the lexer cannot classify");
							else if (comment.slice(at, at + token.length) === token) raise("suppression-comment", item, commit, [`${seam}: ${file}:${n}: ${token}`, raw.trim()]);
						}
					}
				}
			}
			if (focus) {
				// Whole-file text: whitespace between member and call may cross lines.
				const join = (pick: (line: number) => string) => lines.map((_, i) => pick(i)).join("\n");
				const raw = join((i) => lines[i]);
				const code = lexed ? join((i) => lexed[i].code) : null;
				const unsure = lexed ? join((i) => lexed[i].unsure) : null;
				const starts = [0];
				for (const line of lines) starts.push(starts[starts.length - 1] + line.length + 1);
				const lineAt = (offset: number) => { let n = 1; while (starts[n] <= offset) n++; return n; };
				const findings = new Map<number, { call: string; line: number; certain: boolean }>();
				// Code matches prove a call; raw matches that touch unsure or unlexed text cannot be classified.
				for (const [source, isCode] of [[code, true], [raw, false]] as const) {
					if (source === null) continue;
					for (const match of source.matchAll(FOCUS_CALLS)) {
						const from = match.index, to = from + match[0].length;
						const first = lineAt(from), last = lineAt(to - 1);
						let touchesAdded = false;
						for (let n = first; n <= last; n++) if (isAdded.has(n)) touchesAdded = true;
						if (!touchesAdded || findings.get(from)?.certain) continue;
						const certain = isCode && !unsure!.slice(from, to).includes("?");
						if (certain || !isCode && (code === null || unsure!.slice(from, to).includes("?"))) findings.set(from, { call: match[1], line: first, certain });
					}
				}
				for (const { call, line, certain } of findings.values()) {
					if (certain) raise("test-focus", item, commit, [`${seam}: ${file}:${line}: .${call}(`, lines[line - 1].trim()]);
					else unclassified("test-focus", line, `.${call}(`, lexed ? "in syntax the lexer cannot classify" : "in a test language without code evidence");
				}
			}
		}
	}
}

/** The item a commit passes, when it passes exactly one. */
function commitItem(commit: CommitEvent): string | null {
	return commit.passedItems.length === 1 ? commit.passedItems[0] : null;
}
