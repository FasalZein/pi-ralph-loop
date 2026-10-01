import { isJsTs, isTestPath } from "./content.js";
import type { Alert, CommitEvent, FileChange, LaunchBaseline, LoopSnapshot, Mission } from "./types.js";

/** Injection cases 6-9 (spec #1): suppression tokens, matched inside JS/TS comment tokens only. */
export const SUPPRESSION_TOKENS: readonly string[] = ["oxlint-disable", "eslint-disable", "@ts-ignore", "@ts-expect-error"];
/** Injection cases 10-11 (spec #1): a `.skip(` or `.only(` call in test code, never in a string or comment. */
const FOCUS_CALL = /\.\s*(skip|only)\s*\(/;

const CONTENT_RULES = ["suppression-comment", "test-focus", "deleted-test"] as const;
const HISTORY_RULES = ["nonlinear-history", ...CONTENT_RULES] as const;
const GENERIC_RULES = ["branch-changed", "base-not-ancestor", ...HISTORY_RULES] as const;
type GenericRule = (typeof GENERIC_RULES)[number];

const branchName = (branch: string | null) => branch === null ? "(detached HEAD)" : JSON.stringify(branch);

/**
 * Pure generic-rule evaluation over one snapshot. History guards come first,
 * then every commit in base..HEAD oldest first against its first parent, then
 * the index and the worktree. Only fresh evidence is read: a torn observation
 * gives one `observation-retry` WARN and a missing section gives a
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

	const git = snapshot.git;
	const evidence = snapshot.evidence;
	if (!git || !evidence) {
		const torn = snapshot.issues.find((issue) => issue.source === "git" && issue.kind === "concurrent");
		if (torn) emit("observation-retry", "WARN", null, null, [torn.detail]);
		else incomplete("git", GENERIC_RULES, snapshot.sources.git.error ?? "git unavailable");
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
			for (const added of change.content.added) {
				const where = `${seam}: ${file}:${added.line}`;
				if (suppression && added.lexed) {
					for (const token of SUPPRESSION_TOKENS) {
						if (added.lexed.comments.some((comment) => comment.includes(token))) raise("suppression-comment", item, commit, [`${where}: ${token}`, added.text.trim()]);
					}
				}
				if (focus) {
					const call = FOCUS_CALL.exec(added.lexed ? added.lexed.code : added.text);
					if (call) raise("test-focus", item, commit, [`${where}: .${call[1]}(`, added.text.trim()]);
				}
			}
		}
	}
}

/** The item a commit passes, when it passes exactly one. */
function commitItem(commit: CommitEvent): string | null {
	return commit.passedItems.length === 1 ? commit.passedItems[0] : null;
}
