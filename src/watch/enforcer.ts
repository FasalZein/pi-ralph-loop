import { enforcerRuntimePath } from "./alert-log.js";
import path from "node:path";
import type { EnforcementProbes } from "./probes.js";
import { argumentsOnly } from "./test-edit.js";
import { isJsTs, isTestPath, isSourcePath } from "./content.js";
import type { Alert, CommitEvent, FileChange, LaunchBaseline, LoopSnapshot, Mission, SeamPolicyEvidence } from "./types.js";

/** Injection cases 6-9 (spec #1): suppression tokens, matched inside JS/TS comment tokens only. */
export const SUPPRESSION_TOKENS: readonly string[] = ["oxlint-disable", "eslint-disable", "@ts-ignore", "@ts-expect-error"];
/** Injection cases 10-11 (spec #1): a `.skip(` or `.only(` call in test code, never in a string or comment. */
const FOCUS_CALLS = /\.\s*(skip|only)\s*\(/g;

const CONTENT_RULES = ["suppression-comment", "test-focus", "deleted-test"] as const;
const SEAM_POLICY_RULES = ["shape-new-entry", "shape-count-rise", "anti-slop-rise", "protected-path", "items-beyond-pass-flips", "bundle-state-edit", "test-edit", "outside-item-and-importers", "other-area", "large-diff"] as const;
const COMMIT_POLICY_RULES = ["multiple-item-pass", "pass-without-source", "source-without-item-pass", "item-order", "receipt-item-source-scope"] as const;
const SEAM_RULES = [...CONTENT_RULES, ...SEAM_POLICY_RULES] as const;
const HISTORY_RULES = ["nonlinear-history", ...SEAM_RULES, ...COMMIT_POLICY_RULES] as const;
const GENERIC_RULES = ["branch-changed", "base-not-ancestor", ...HISTORY_RULES] as const;

const branchName = (branch: string | null) => branch === null ? "(detached HEAD)" : JSON.stringify(branch);

/**
 * Pure policy evaluation over one snapshot. History guards come first,
 * then every commit in base..HEAD oldest first against its first parent, then
 * the index and the worktree. Only fresh evidence is read: an observation with
 * any concurrent-change issue gives one `observation-retry` WARN and a missing section gives a
 * `coverage-incomplete` WARN, never silence. `launch` is the branch captured at
 * launch; it is the baseline when the mission sets no branch.
 */
export function evaluate(snapshot: LoopSnapshot, mission: Mission, launch: LaunchBaseline | null, probes: EnforcementProbes = {}): readonly Alert[] {
	const alerts = new Map<string, Alert>();
	const emit = (rule: string, level: Alert["level"], item: string | null, commit: string | null, evidence: readonly string[]) => {
		const key = JSON.stringify([rule, level, item, commit, evidence]);
		if (!alerts.has(key)) alerts.set(key, { timestamp: snapshot.observedAt, level, rule, item, commit, evidence, run: snapshot.run });
	};
	const level = (rule: string): Alert["level"] | null => {
		const configured = mission.rules[rule];
		return configured === "hard" ? "HARD" : configured === "warn" ? "WARN" : null;
	};
	const raise = (rule: string, item: string | null, commit: string | null, evidence: readonly string[]) => {
		const found = level(rule);
		if (found) emit(rule, found, item, commit, evidence);
	};
	// Owner decision on #11 (2026-10-01): coverage-incomplete and observation-retry are WARN.
	const incomplete = (section: string, rules: readonly string[], cause: string, commit: string | null = null) => {
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
		incomplete("git", [...GENERIC_RULES, "debt-measure-rise"], snapshot.sources.git.error ?? "git unavailable");
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
			if (!seam || seam.status !== "fresh") incomplete(`commit ${commit.sha}`, [...SEAM_RULES, ...COMMIT_POLICY_RULES], seam?.error ?? "no content evidence", commit.sha);
			else {
				check(seam.changes, `commit ${commit.sha}`, commit.sha, commitItem(commit));
				policy(seam.policy, seam.changes, `commit ${commit.sha}`, commit.sha, commitItem(commit), commit.blockerItem);
				workflow(commit, seam.changes, seam.policy);
				if (!mission.git.parentCommits.some(parent => parent.sha === commit.sha)) scope(seam.changes, `commit ${commit.sha}`, commit.sha, commitItem(commit));
			}
		}
	}

	for (const [name, seam] of [["index", evidence.index], ["worktree", evidence.worktree]] as const) {
		if (seam.status !== "fresh") incomplete(name, name === "worktree" ? [...SEAM_RULES, "debt-measure-rise"] : SEAM_RULES, seam.error);
		else { check(seam.changes, name, null, snapshot.currentItem); policy(seam.policy, seam.changes, name, null, snapshot.currentItem, snapshot.currentItem); scope(seam.changes, name, null, snapshot.currentItem); }
	}
	if (evidence.worktree.status === "fresh") measure();
	return [...alerts.values()];

	function measure(): void {
		if (!mission.measure || !level("debt-measure-rise")) return;
		const result = probes.measure;
		if (!result || result.kind === "unavailable") { emit("measure-unavailable", "WARN", null, null, [result?.reason ?? "measurement result not supplied"]); return; }
		const missing = Object.keys(mission.measure.start).filter(key => !Object.hasOwn(result.value, key));
		if (missing.length) { emit("measure-unavailable", "WARN", null, null, [`missing measurement counts: ${missing.join(", ")}`]); return; }
		for (const [key, count] of Object.entries(result.value)) {
			if (!Object.hasOwn(mission.measure.start, key)) { emit("measure-unavailable", "WARN", null, null, [`no start count for ${key}`]); continue; }
			if (count > mission.measure.start[key]) raise("debt-measure-rise", snapshot.currentItem, null, [`worktree: measured ${key} ${mission.measure.start[key]} -> ${count}`]);
		}
	}
	function scope(changes: readonly FileChange[], seam: string, commit: string | null, item: string | null): void {
		if (mission.bundle === null || !level("outside-item-and-importers") || !changes.length) return;
		const authorChanges = changes.filter(change => !change.path.startsWith(".ralph/"));
		if (!authorChanges.length) return;
		if (item === null) { incomplete(seam, ["outside-item-and-importers"], "current or passed item unavailable", commit); return; }
		const policy = mission.scope.items.find(scope => scope.id === item);
		if (!policy) { incomplete(seam, ["outside-item-and-importers"], `scope not configured for ${item}`, commit); return; }
		const importers = probes.importers?.[item];
		if (!importers || importers.kind === "unavailable") { emit("importer-check-unavailable", "WARN", item, commit, [`${seam}: ${importers?.reason ?? "importer result not supplied"}`]); return; }
		const permitted = [...policy.allowedPaths, ...policy.targets, ...importers.value];
		const outside = authorChanges.filter(change => !permitted.some(allowed => allowed === "." || change.path === allowed || change.path.startsWith(`${allowed}/`)));
		if (outside.length) raise("outside-item-and-importers", item, commit, [`${seam}: paths outside ${item} and its importers`, ...outside.map(change => change.path)]);
	}

	function workflow(commit: CommitEvent, changes: readonly FileChange[], data: SeamPolicyEvidence): void {
		const approved = mission.git.parentCommits.find(parent => parent.sha === commit.sha);
		if (approved) {
			emit("approved-parent-commit", "INFO", null, commit.sha, [`commit ${commit.sha}: approved parent`, approved.reason]);
			return;
		}
		if (mission.bundle === null) return;
		const rules = ["multiple-item-pass", "pass-without-source", "source-without-item-pass", "item-order"];
		if (!commit.passesKnown) { incomplete(`commit ${commit.sha}`, rules, "item passes unknown", commit.sha); return; }
		const source = changes.filter(change => isSourcePath(mission, change.path));
		const item = commitItem(commit), seam = `commit ${commit.sha}:`;
		if (commit.passedItems.length > 1) raise("multiple-item-pass", null, commit.sha, [`${seam} passes ${commit.passedItems.join(", ")}`]);
		for (const passed of commit.passedItems) {
			if (source.length && mission.scope.receiptItems.includes(passed)) raise("receipt-item-source-scope", passed, commit.sha, [`${seam} receipt item ${passed} passed with source changes`, ...source.map(change => change.path)]);
			if (!source.length && !mission.scope.receiptItems.includes(passed)) raise("pass-without-source", passed, commit.sha, [`${seam} item ${passed} passed without source change`]);
		}
		if (source.length && !commit.passedItems.length) raise("source-without-item-pass", item, commit.sha, [`${seam} source changed without an item pass`, ...source.map(change => change.path)]);
		if (commit.passedItems.length && level("item-order")) {
			if (!data.items || "unavailable" in data.items) incomplete(`commit ${commit.sha}`, ["item-order"], "item order unavailable", commit.sha);
			else if (commit.passedItems.some((key, index) => data.items && !("unavailable" in data.items) && key !== data.items.beforePending[index])) raise("item-order", item, commit.sha, [`${seam} expected ${data.items.beforePending[0] ?? "no pending item"}, passed ${commit.passedItems.join(", ")}`]);
		}
	}

	function policy(data: SeamPolicyEvidence, changes: readonly FileChange[], seam: string, commit: string | null, item: string | null, blocker: string | null): void {
		if (mission.bundle !== null && data.items && level("items-beyond-pass-flips")) {
			if ("unavailable" in data.items) incomplete(`${seam} items`, ["items-beyond-pass-flips"], data.items.unavailable, commit);
			else {
				const diff = data.items;
				const edited = diff.edited.filter(edit => !(edit.key === blocker && edit.fields.length === 1 && edit.fields[0] === "regression_notes"));
				if (diff.inserted.length || diff.removed.length || diff.unpassed.length || edited.length || diff.documentEdited) raise("items-beyond-pass-flips", item, commit, [`${seam}: items changed beyond pass flips`, JSON.stringify({ inserted: diff.inserted, removed: diff.removed, unpassed: diff.unpassed, edited, documentEdited: diff.documentEdited })]);
			}
		}
		if (mission.thresholds && level("large-diff")) {
			const paths = changes.length, lines = data.numstat.reduce((n, row) => n + (row.added ?? 0) + (row.removed ?? 0), 0);
			const { largeDiffPaths, largeDiffLines } = mission.thresholds;
			if (largeDiffPaths !== undefined && paths > largeDiffPaths || largeDiffLines !== undefined && lines > largeDiffLines) raise("large-diff", item, commit, [`${seam}: ${paths} paths, ${lines} changed lines`, `authority: ${mission.thresholds.authority}`]);
			if (largeDiffLines !== undefined && data.numstat.some(row => row.added === null || row.removed === null)) incomplete(`${seam} line count`, ["large-diff"], "binary or unavailable line count", commit);
		}
		for (const change of changes) {
			for (const area of mission.otherAreas) if (area.globs.some(glob => path.posix.matchesGlob(change.path, glob))) raise("other-area", item, commit, [`${seam}: ${JSON.stringify(change.path)} in ${area.name}`]);
			if (mission.bundle !== null && change.path.startsWith(".ralph/") && !bundleRuntimePath(change.path)) raise("bundle-state-edit", item, commit, [`${seam}: bundle state ${JSON.stringify(change.path)} changed`]);
			if (!isTestPath(mission, change.path) || change.status === "D" || !level("test-edit")) continue;
			if (change.content.kind !== "lines") { incomplete(`${seam} ${JSON.stringify(change.path)}`, ["test-edit"], "test content unavailable", commit); continue; }
			const before = data.oldLines[change.path];
			if (mission.testEdit && before === undefined) { incomplete(`${seam} ${JSON.stringify(change.path)}`, ["test-edit"], "old test content unavailable", commit); continue; }
			if (mission.testEdit && isJsTs(change.path) && argumentsOnly(change.path, before!, change.content.lines, mission.testEdit.functions)) continue;
			raise("test-edit", item, commit, [`${seam}: edited test ${JSON.stringify(change.path)}`]);
		}
		for (const baseline of mission.baselines) {
			const rules = baseline.name === "shape" ? ["shape-new-entry", "shape-count-rise"] : baseline.name === "anti-slop" ? ["anti-slop-rise"] : [];
			if (!rules.some(rule => level(rule))) continue;
			const sides = data.debt[baseline.name];
			if (!sides) continue;
			if (sides.after.kind !== "ok" || sides.before.kind === "invalid") {
				incomplete(`${seam} ${JSON.stringify(baseline.file)}`, rules, "baseline missing or invalid", commit); continue;
			}
			const entries = (value: Readonly<Record<string, number>> | readonly string[]) => Array.isArray(value) ? value.map(key => [key, 0] as const) : Object.entries(value);
			const old = new Map(sides.before.kind === "ok" ? entries(sides.before.value) : []);
			for (const [key, count] of entries(sides.after.value)) {
				const evidence = [`${seam}: ${JSON.stringify(baseline.file)}: ${JSON.stringify(key)} ${old.get(key) ?? "absent"} -> ${count}`];
				if (baseline.name === "shape") {
					if (!old.has(key)) raise("shape-new-entry", item, commit, evidence);
					else if (count > old.get(key)!) raise("shape-count-rise", item, commit, evidence);
				} else if (!old.has(key) || count > old.get(key)!) raise("anti-slop-rise", item, commit, evidence);
			}
		}
	}

	function check(changes: readonly FileChange[], seam: string, commit: string | null, item: string | null): void {
		for (const change of changes) {
			const file = JSON.stringify(change.path);
			const test = isTestPath(mission, change.path);
			if (mission.protected.paths.includes(change.path) || mission.protected.prefixes.some(prefix => prefix === "." || change.path === prefix || change.path.startsWith(`${prefix}/`))) raise("protected-path", item, commit, [`${seam}: protected path ${file}`]);
			if (change.status === "D") {
				// Size is irrelevant: an empty test file deleted is still a deleted test.
				if (test) raise("deleted-test", item, commit, [`${seam}: deleted test ${file}`]);
				continue;
			}
			const suppression = isJsTs(change.path) && level("suppression-comment") !== null;
			const focus = test && level("test-focus") !== null;
			if (!suppression && !focus) continue;
			if (change.content.kind !== "lines") {
				const rules: string[] = [...(suppression ? ["suppression-comment" as const] : []), ...(focus ? ["test-focus" as const] : [])];
				incomplete(`${seam} ${file}`, rules, change.content.kind === "unavailable" ? change.content.reason : "content not collected", commit);
				continue;
			}
			const { lines, added, lexed } = change.content;
			const isAdded = new Set(added);
			const unclassified = (rule: string, line: number, what: string, reason: string) =>
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
						// An added line must supply a call token: a comment or blank line inserted into an existing call is not a new call.
						let touchesAdded = false;
						for (let n = first; n <= last; n++) {
							if (isAdded.has(n) && source.slice(Math.max(from, starts[n - 1]), Math.min(to, starts[n] - 1)).trim() !== "") touchesAdded = true;
						}
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

/** Launcher-owned files are not author bundle policy. mission.json is checked by T12. */
function bundleRuntimePath(file: string): boolean {
	return enforcerRuntimePath(file) || ["items.json", "progress.md", "mission.json", "loop.md", "driver.json", "driver.lock", "launch.lock", "rpc.in", "steer", "watch-host.json"].some(name => file === `.ralph/${name}`)
		|| file.startsWith(".ralph/steer/")
		|| /^\.ralph\/launch-[^/]+\.json(?:\.\d+\.tmp)?$/.test(file)
		|| /^\.ralph\/(?:watch-host|driver)\.json\.\d+\.tmp$/.test(file)
		|| /^\.ralph\/journal(?:\.\d+)?\.jsonl$/.test(file);
}
