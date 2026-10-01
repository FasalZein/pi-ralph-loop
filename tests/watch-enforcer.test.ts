import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { evaluate } from "../src/watch/enforcer.ts";
import { GitCommandError, openLoop, type ObservationRuntime } from "../src/watch/loop-state.ts";
import type { Alert, LaunchBaseline, LoopSnapshot } from "../src/watch/types.ts";
import { clock, Fixture, midRead, readOnce, T } from "./fixtures/loop-state.ts";

// Expected rule ids, levels and seams come from spec #1 (generic safety defaults,
// injection cases 6-11 and 21, supplemental branch/ancestry/merge/empty-test-deletion)
// and the owner decisions on #11 (JS/TS scope, WARN for coverage and retry).

const TEST_DISCOVERY = { scope: { testGlobs: ["**/*.test.ts"] } };
const SEAMS = ["commit", "index", "worktree"] as const;
type Seam = (typeof SEAMS)[number];

type Scratch = { f: Fixture; launch: LaunchBaseline };
function scratch(extra: Record<string, unknown> = TEST_DISCOVERY, plain = false): Scratch {
	const f = new Fixture([{ id: "A", passes: false }], { extra, plain });
	write(f, "src/a.ts", "export const a = 1;\n");
	write(f, "tests/a.test.ts", "import { it } from \"node:test\";\nit(\"a\", () => {});\n");
	f.commit("baseline files", T("09:30"));
	// The launch-captured branch: the baseline when the mission sets none.
	return { f, launch: { branch: f.git("symbolic-ref", "--short", "HEAD") } };
}
function write(f: Fixture, rel: string, text: string): void {
	mkdirSync(path.dirname(path.join(f.root, rel)), { recursive: true });
	writeFileSync(path.join(f.root, rel), text);
}
const append = (f: Fixture, rel: string, text: string) => write(f, rel, `${f.git("show", `HEAD:${rel}`)}\n${text}`);
/** Lands a change in one seam: unstaged worktree, staged index, or a commit. Returns the commit SHA. */
function land(f: Fixture, seam: Seam, change: () => void): string | null {
	change();
	if (seam === "worktree") return null;
	f.git("add", "-A");
	return seam === "index" ? null : f.commit("inject", T("10:00"));
}
async function run({ f, launch }: Scratch, runtime?: ObservationRuntime): Promise<{ s: LoopSnapshot; alerts: readonly Alert[] }> {
	const s = await readOnce(f, runtime);
	assert.ok(s.mission, JSON.stringify(s.issues));
	return { s, alerts: evaluate(s, s.mission, launch) };
}
const summary = (alerts: readonly Alert[]) => alerts.map((a) => `${a.level} ${a.rule}`);
const seamLabel = (seam: Seam, sha: string | null) => seam === "commit" ? `commit ${sha}:` : `${seam}:`;

/** One HARD finding of `rule`, located in the seam the change landed in. */
async function expectHard(x: Scratch, seam: Seam, sha: string | null, rule: string): Promise<Alert> {
	const { alerts } = await run(x);
	assert.deepEqual(summary(alerts), [`HARD ${rule}`], JSON.stringify(alerts, null, 1));
	assert.equal(alerts[0].commit, sha);
	assert.ok(alerts[0].evidence[0].startsWith(seamLabel(seam, sha)), alerts[0].evidence[0]);
	return alerts[0];
}

// ---- Injection cases 6-9: suppression comments ----

const SUPPRESSIONS = [
	["comment-oxlint-disable", "/* oxlint-disable no-console */", "oxlint-disable"],
	["comment-eslint-disable", "// eslint-disable-next-line no-console", "eslint-disable"],
	["comment-ts-ignore", "// @ts-ignore", "@ts-ignore"],
	["comment-ts-expect-error", "// @ts-expect-error", "@ts-expect-error"],
] as const;
for (const [name, line, token] of SUPPRESSIONS) {
	for (const seam of SEAMS) {
		test(`${name} (${seam}): an added suppression comment in a TS file is HARD`, async () => {
			const x = scratch();
			try {
				const sha = land(x.f, seam, () => append(x.f, "src/a.ts", `${line}\nexport const b: number = "x";\n`));
				const alert = await expectHard(x, seam, sha, "suppression-comment");
				assert.ok(alert.evidence[0].includes(`"src/a.ts":2: ${token}`), alert.evidence[0]);
				assert.equal(alert.timestamp, T("12:00"));
			} finally { x.f.close(); }
		});
	}
}

test("suppression in an untracked new JS file is HARD from the worktree", async () => {
	const x = scratch();
	try {
		write(x.f, "src/new.mjs", "// eslint-disable\nexport default 1;\n");
		const alert = await expectHard(x, "worktree", null, "suppression-comment");
		assert.ok(alert.evidence[0].includes(`"src/new.mjs":1: eslint-disable`));
	} finally { x.f.close(); }
});

test("suppression inside a multi-line block comment is HARD (whole-file lexing)", async () => {
	const x = scratch();
	try {
		const sha = land(x.f, "commit", () => append(x.f, "src/a.ts", "/*\n * eslint-disable\n */\n"));
		await expectHard(x, "commit", sha, "suppression-comment");
	} finally { x.f.close(); }
});

for (const seam of SEAMS) {
	test(`syntax negatives (${seam}): suppression tokens in strings, templates, regexes and non-JS files raise nothing`, async () => {
		const x = scratch();
		try {
			land(x.f, seam, () => {
				append(x.f, "src/a.ts", [
					"export const s = \"// @ts-ignore\";",
					"export const t = `/* eslint-disable */ ${s}`;",
					"export const r = /\\/\\/ oxlint-disable/;",
					"export const u = '@ts-expect-error';",
				].join("\n"));
				write(x.f, "docs/notes.md", "// @ts-ignore is forbidden\n");
				write(x.f, "src/style.css", "/* eslint-disable */\n");
			});
			assert.deepEqual(summary((await run(x)).alerts), []);
		} finally { x.f.close(); }
	});
}

// Review fix round 1, finding 1: valid literal syntax never proves a comment.
for (const seam of SEAMS) {
	test(`literal syntax (${seam}): continued strings and control-flow regexes raise nothing`, async () => {
		const x = scratch();
		try {
			land(x.f, seam, () => append(x.f, "src/a.ts", [
				"export const s = \"a\\",
				"// @ts-ignore\";",
				"if (true) /[/* eslint-disable */]/.test(\"x\");",
				"while (false) /\\/\\/ oxlint-disable/.exec(\"y\");",
			].join("\n")));
			assert.deepEqual(summary((await run(x)).alerts), []);
		} finally { x.f.close(); }
	});

	test(`JSX text (${seam}): a token in JSX text is coverage incomplete, never HARD; a JSX comment expression is HARD`, async () => {
		const x = scratch();
		try {
			const sha = land(x.f, seam, () => write(x.f, "src/view.tsx", "export const note = <div>// @ts-ignore</div>;\n"));
			let alerts = (await run(x)).alerts;
			assert.deepEqual(summary(alerts), ["WARN coverage-incomplete"], JSON.stringify(alerts, null, 1));
			assert.equal(alerts[0].evidence[0], `${seamLabel(seam, sha)} "src/view.tsx":1: @ts-ignore in syntax the lexer cannot classify`);
			land(x.f, seam, () => write(x.f, "src/view.tsx", "export const note = <div>{/* eslint-disable */}</div>;\n"));
			alerts = (await run(x)).alerts;
			assert.ok(summary(alerts).includes("HARD suppression-comment"), JSON.stringify(alerts, null, 1));
			assert.ok(alerts.some((a) => a.level === "HARD" && a.evidence[0].endsWith(`"src/view.tsx":1: eslint-disable`)));
		} finally { x.f.close(); }
	});
}

test("ambiguous slash after a block is coverage incomplete, never HARD", async () => {
	const x = scratch();
	try {
		append(x.f, "src/a.ts", "{ }\n/[/* eslint-disable */]/.test(\"x\");");
		const { alerts } = await run(x);
		assert.deepEqual(summary(alerts), ["WARN coverage-incomplete"], JSON.stringify(alerts, null, 1));
	} finally { x.f.close(); }
});

// ---- Injection cases 10-11: focused or skipped tests ----

for (const [name, line, call] of [["test-skip", "describe.skip(\"later\", () => {});", ".skip("], ["test-only", "it.only(\"focus\", () => {});", ".only("]] as const) {
	for (const seam of SEAMS) {
		test(`${name} (${seam}): an added ${call} in a discovered test is HARD`, async () => {
			const x = scratch();
			try {
				const sha = land(x.f, seam, () => append(x.f, "tests/a.test.ts", line));
				const alert = await expectHard(x, seam, sha, "test-focus");
				assert.ok(alert.evidence[0].endsWith(`"tests/a.test.ts":3: ${call}`), alert.evidence[0]);
			} finally { x.f.close(); }
		});
	}
}

for (const seam of SEAMS) {
	test(`focus negatives (${seam}): .only( outside tests, in strings or comments raises nothing`, async () => {
		const x = scratch();
		try {
			land(x.f, seam, () => {
				append(x.f, "src/a.ts", "export const pick = (xs: string[]) => xs.filter(Boolean).only?.();\nexport const call = { only: (n: number) => n }.only(1);");
				append(x.f, "tests/a.test.ts", "it(\"names it.only( in a string\", () => {});\n// it.skip( was removed\n");
			});
			assert.deepEqual(summary((await run(x)).alerts), []);
		} finally { x.f.close(); }
	});
}

// Review fix round 1, finding 2: raw text in a test language without a lexer
// cannot prove a call. A possible call is WARN coverage-incomplete, never HARD.
for (const seam of SEAMS) {
	test(`non-JS tests (${seam}): focus text without code evidence is coverage incomplete, not HARD`, async () => {
		const x = scratch({ scope: { testRegex: "^.*_spec\\.rb$" } });
		try {
			write(x.f, "spec/a_spec.rb", "describe \"a\" do\nend\n");
			x.f.commit("ruby spec", T("09:40"));
			land(x.f, seam, () => append(x.f, "spec/a_spec.rb", "example = \"describe.only( is not a call\"\n# it.skip( was removed\nputs 1"));
			const { alerts } = await run(x);
			assert.deepEqual(summary(alerts), ["WARN coverage-incomplete", "WARN coverage-incomplete"], JSON.stringify(alerts, null, 1));
			assert.match(alerts[0].evidence[0], /"spec\/a_spec\.rb":3: \.only\( in a test language without code evidence$/);
			assert.equal(alerts[0].evidence[1], "rules not checked: test-focus");
			assert.match(alerts[1].evidence[0], /"spec\/a_spec\.rb":4: \.skip\(/);
		} finally { x.f.close(); }
	});
}

test("non-JS tests: added lines without focus text raise nothing", async () => {
	const x = scratch({ scope: { testRegex: "^.*_spec\\.rb$" } });
	try {
		write(x.f, "spec/a_spec.rb", "describe \"a\" do\n  it \"works\" do\n  end\nend\n");
		assert.deepEqual(summary((await run(x)).alerts), []);
	} finally { x.f.close(); }
});

// Review fix round 1, finding 3: whitespace between member and call may cross lines.
for (const [name, text, call, line] of [["multiline-only", "it.only\n(\"focus\", () => {});", ".only(", 3], ["multiline-skip", "describe\n  .skip\n  (\"later\", () => {});", ".skip(", 4]] as const) {
	for (const seam of SEAMS) {
		test(`${name} (${seam}): a focus call split across lines is HARD`, async () => {
			const x = scratch();
			try {
				const sha = land(x.f, seam, () => append(x.f, "tests/a.test.ts", text));
				const alert = await expectHard(x, seam, sha, "test-focus");
				assert.ok(alert.evidence[0].endsWith(`"tests/a.test.ts":${line}: ${call}`), alert.evidence[0]);
			} finally { x.f.close(); }
		});
	}
}

test("multiline focus: a call completed by an added line on an existing member is HARD", async () => {
	const x = scratch();
	try {
		write(x.f, "tests/b.test.ts", "import { it } from \"node:test\";\nit.only\n");
		x.f.commit("dangling member", T("09:40"));
		const sha = land(x.f, "commit", () => append(x.f, "tests/b.test.ts", "(\"x\", () => {});"));
		const alert = await expectHard(x, "commit", sha, "test-focus");
		assert.ok(alert.evidence[0].endsWith(`"tests/b.test.ts":2: .only(`), alert.evidence[0]);
	} finally { x.f.close(); }
});

// ---- Injection case 21 and supplemental empty-test-deletion ----

for (const [name, content] of [["deleted-test", null], ["empty-test-deletion", ""]] as const) {
	for (const seam of SEAMS) {
		test(`${name} (${seam}): deleting a discovered test is HARD`, async () => {
			const x = scratch();
			try {
				if (content !== null) { write(x.f, "tests/empty.test.ts", content); x.f.commit("empty test", T("09:40")); }
				const target = content === null ? "tests/a.test.ts" : "tests/empty.test.ts";
				const sha = land(x.f, seam, () => rmSync(path.join(x.f.root, target)));
				const alert = await expectHard(x, seam, sha, "deleted-test");
				assert.equal(alert.evidence[0], `${seamLabel(seam, sha)} deleted test ${JSON.stringify(target)}`);
			} finally { x.f.close(); }
		});
	}
}

test("deleted-test: a test path with a newline is reported exactly; a deleted source file is not a test", async () => {
	const x = scratch();
	try {
		write(x.f, "tests/odd\nname.test.ts", "it(\"x\", () => {});\n");
		x.f.commit("odd test", T("09:40"));
		const sha = land(x.f, "commit", () => { rmSync(path.join(x.f.root, "tests/odd\nname.test.ts")); rmSync(path.join(x.f.root, "src/a.ts")); });
		const alert = await expectHard(x, "commit", sha, "deleted-test");
		assert.equal(alert.evidence[0], `commit ${sha}: deleted test "tests/odd\\nname.test.ts"`);
	} finally { x.f.close(); }
});

test("deleted-test: renaming a test to a non-test path is a deleted test", async () => {
	const x = scratch();
	try {
		const sha = land(x.f, "commit", () => x.f.git("mv", "tests/a.test.ts", "tests/a.helper.ts"));
		await expectHard(x, "commit", sha, "deleted-test");
	} finally { x.f.close(); }
});

test("without test discovery, test-focus and deleted-test are off (no test root is assumed)", async () => {
	const x = scratch({});
	try {
		land(x.f, "commit", () => { append(x.f, "tests/a.test.ts", "it.only(\"x\", () => {});"); });
		land(x.f, "commit", () => rmSync(path.join(x.f.root, "tests/a.test.ts")));
		assert.deepEqual(summary((await run(x)).alerts), []);
	} finally { x.f.close(); }
});

// ---- Supplemental branch, ancestry, merge ----

for (const seam of SEAMS) {
	test(`branch (${seam}): HEAD on another branch than the launch-captured one is HARD`, async () => {
		const x = scratch();
		try {
			x.f.git("checkout", "-q", "-b", "elsewhere");
			land(x.f, seam, () => append(x.f, "src/a.ts", "export const c = 3;"));
			const { s, alerts } = await run(x);
			assert.deepEqual(summary(alerts), ["HARD branch-changed"]);
			assert.equal(alerts[0].commit, s.git!.head);
			assert.deepEqual(alerts[0].evidence, [`expected branch ${JSON.stringify(x.launch.branch)}`, "observed branch \"elsewhere\""]);
		} finally { x.f.close(); }
	});
}

test("branch: the mission branch wins over the launch baseline; detached HEAD is a change", async () => {
	const x = scratch();
	try {
		const s = await readOnce(x.f);
		const mission = { ...s.mission!, git: { ...s.mission!.git, branch: "release" } };
		assert.deepEqual(summary(evaluate(s, mission, x.launch)), ["HARD branch-changed"]);
		x.f.git("checkout", "-q", "--detach");
		const detached = await readOnce(x.f);
		const alerts = evaluate(detached, detached.mission!, x.launch);
		assert.deepEqual(alerts.map((a) => a.evidence[1]), ["observed branch (detached HEAD)"]);
		// A launch on a detached HEAD expects a detached HEAD.
		assert.deepEqual(evaluate(detached, detached.mission!, { branch: null }), []);
	} finally { x.f.close(); }
});

test("branch: no mission branch and no launch baseline is coverage incomplete, not clean", async () => {
	const x = scratch();
	try {
		const s = await readOnce(x.f);
		const alerts = evaluate(s, s.mission!, null);
		assert.deepEqual(summary(alerts), ["WARN coverage-incomplete"]);
		assert.deepEqual(alerts[0].evidence, ["branch: no mission branch and no launch-captured branch", "rules not checked: branch-changed"]);
	} finally { x.f.close(); }
});

test("ancestry: base no longer an ancestor of HEAD is HARD; history rules report incomplete", async () => {
	const x = scratch();
	try {
		// Same tree, rewritten history: the branch name stays, the base is gone.
		const orphan = x.f.git("commit-tree", "HEAD^{tree}", "-m", "rewritten");
		x.f.git("reset", "-q", "--hard", orphan);
		const { s, alerts } = await run(x);
		assert.deepEqual(summary(alerts), ["HARD base-not-ancestor", "WARN coverage-incomplete"]);
		assert.deepEqual(alerts[0].evidence, [`base ${s.mission!.git.baseCommit} is not an ancestor of HEAD ${orphan}`]);
		assert.match(alerts[1].evidence[1], /nonlinear-history, suppression-comment, test-focus, deleted-test/);
	} finally { x.f.close(); }
});

test("merge: a merge commit in base..HEAD is HARD, and its content is still checked against the first parent", async () => {
	const x = scratch();
	try {
		const main = x.launch.branch!;
		x.f.git("checkout", "-q", "-b", "side");
		write(x.f, "src/side.ts", "export const side = 1;\n");
		x.f.commit("side", T("09:50"));
		x.f.git("checkout", "-q", main);
		write(x.f, "src/main.ts", "export const main = 1;\n");
		x.f.commit("main", T("09:55"));
		x.f.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
		const merge = x.f.git("rev-parse", "HEAD");
		const { alerts } = await run(x);
		assert.deepEqual(summary(alerts), ["HARD nonlinear-history"]);
		assert.equal(alerts[0].commit, merge);
		assert.deepEqual(alerts[0].evidence, [`merge commit ${merge} has 2 parents`, "merge side"]);
	} finally { x.f.close(); }
});

// ---- Clean, revert, staged-then-repaired, levels ----

test("clean-single-item: one item pass with source and test edits raises no alert", async () => {
	const x = scratch();
	try {
		append(x.f, "src/a.ts", "export const done = true;");
		append(x.f, "tests/a.test.ts", "it(\"done\", () => {});");
		x.f.pass("A", T("10:00"));
		x.f.state(true, T("09:45"));
		const { s, alerts } = await run(x);
		assert.equal(s.git?.commits?.at(-1)?.kind, "item-pass");
		assert.deepEqual(alerts, []);
	} finally { x.f.close(); }
});

test("revert: a violating commit reverted by a later commit is still HARD on that commit", async () => {
	const x = scratch();
	try {
		const bad = land(x.f, "commit", () => append(x.f, "src/a.ts", "// @ts-ignore\nexport const b: number = \"x\";"));
		land(x.f, "commit", () => write(x.f, "src/a.ts", "export const a = 1;\n"));
		const alert = await expectHard(x, "commit", bad, "suppression-comment");
		assert.equal(alert.commit, bad);
	} finally { x.f.close(); }
});

test("a staged violation repaired only in the worktree is still HARD from the index", async () => {
	const x = scratch();
	try {
		land(x.f, "index", () => append(x.f, "tests/a.test.ts", "it.only(\"x\", () => {});"));
		write(x.f, "tests/a.test.ts", x.f.git("show", "HEAD:tests/a.test.ts") + "\n");
		await expectHard(x, "index", null, "test-focus");
	} finally { x.f.close(); }
});

test("configured levels: warn grades WARN, off raises nothing", async () => {
	const x = scratch({ ...TEST_DISCOVERY, rules: { "suppression-comment": "warn", "test-focus": "off" } });
	try {
		append(x.f, "src/a.ts", "// @ts-ignore");
		append(x.f, "tests/a.test.ts", "it.only(\"x\", () => {});");
		assert.deepEqual(summary((await run(x)).alerts), ["WARN suppression-comment"]);
	} finally { x.f.close(); }
});

test("plain-task loops get the generic rules", async () => {
	const x = scratch(TEST_DISCOVERY, true);
	try {
		const sha = land(x.f, "commit", () => append(x.f, "src/a.ts", "// @ts-expect-error"));
		await expectHard(x, "commit", sha, "suppression-comment");
	} finally { x.f.close(); }
});

test("alerts carry the run key; evaluate is deterministic", async () => {
	const x = scratch();
	try {
		append(x.f, "src/a.ts", "// @ts-ignore");
		x.f.state(true, T("09:45"), "run-z");
		const { s, alerts } = await run(x);
		assert.deepEqual(alerts.map((a) => a.run.loopToken), ["run-z"]);
		assert.deepEqual(evaluate(s, s.mission!, x.launch), alerts);
	} finally { x.f.close(); }
});

// ---- Torn and incomplete observations ----

test("torn observation: a violation written during the read gives a retry, not HARD; the next read is HARD", async () => {
	const x = scratch();
	const reader = openLoop(x.f.root, { runtime: midRead(() => append(x.f, "src/a.ts", "// @ts-ignore")) });
	try {
		let s = await reader.read();
		let alerts = evaluate(s, s.mission!, x.launch);
		assert.deepEqual(summary(alerts), ["WARN observation-retry"]);
		assert.equal(s.evidence, null);
		s = await reader.read();
		alerts = evaluate(s, s.mission!, x.launch);
		assert.deepEqual(summary(alerts), ["HARD suppression-comment"]);
	} finally { await reader.close(); x.f.close(); }
});

// Review fix round 1, finding 4: any concurrent source makes the observation torn.
test("relaunch during the read: a rewritten loop.md gives a retry, not HARD with a null run key", async () => {
	const x = scratch();
	x.f.state(false, T("09:45"), "run-a");
	const reader = openLoop(x.f.root, { runtime: midRead(() => x.f.state(true, T("10:20"), "run-b")) });
	try {
		append(x.f, "src/a.ts", "// @ts-ignore");
		let s = await reader.read();
		let alerts = evaluate(s, s.mission!, x.launch);
		assert.deepEqual(summary(alerts), ["WARN observation-retry"], JSON.stringify(alerts, null, 1));
		assert.match(alerts[0].evidence.join("\n"), /^state: /m);
		s = await reader.read();
		alerts = evaluate(s, s.mission!, x.launch);
		assert.deepEqual(summary(alerts), ["HARD suppression-comment"]);
		assert.equal(alerts[0].run.loopToken, "run-b");
	} finally { await reader.close(); x.f.close(); }
});

// Review fix round 1, finding 5: an A-to-B-to-A edit during evidence collection.
const CLEAN = "export const a = 1;\nexport const d = 4;\n";
const DIRTY = "export const a = 1;\n// @ts-ignore\n";
for (const kind of ["dirty tracked", "untracked"] as const) {
	test(`A-B-A (${kind}): a temporary violation restored before the second stamp gives a retry, not HARD`, async () => {
		const x = scratch();
		const rel = kind === "untracked" ? "src/new.ts" : "src/a.ts";
		const full = path.join(x.f.root, rel);
		write(x.f, rel, CLEAN);
		const base = clock();
		let armed = true;
		const flip = async <T>(read: () => Promise<T>): Promise<T> => {
			armed = false;
			writeFileSync(full, DIRTY);
			try { return await read(); } finally { writeFileSync(full, CLEAN); }
		};
		const runtime: ObservationRuntime = {
			...base,
			git(root, args, signal) {
				const worktreeDiff = args[1] === "diff" && args.at(-1) === rel && args[args.indexOf("--") - 1] === "--no-renames";
				return armed && kind !== "untracked" && worktreeDiff ? flip(() => base.git(root, args, signal)) : base.git(root, args, signal);
			},
			readRange(file, start, end) {
				return armed && kind === "untracked" && file === full ? flip(() => base.readRange(file, start, end)) : base.readRange(file, start, end);
			},
		};
		const reader = openLoop(x.f.root, { runtime });
		try {
			// Warm the untracked file's stamp read so the flip lands in the evidence read, not the git stamp.
			if (kind === "untracked") { armed = false; await reader.read(); armed = true; }
			let s = await reader.read();
			assert.equal(armed, false, "the flip ran");
			let alerts = evaluate(s, s.mission!, x.launch);
			assert.deepEqual(summary(alerts), ["WARN observation-retry"], JSON.stringify(alerts, null, 1));
			s = await reader.read();
			assert.deepEqual(evaluate(s, s.mission!, x.launch), []);
		} finally { await reader.close(); x.f.close(); }
	});
}

test("incomplete: an unreadable index seam is coverage incomplete, and other seams still raise", async () => {
	const x = scratch();
	const base = clock();
	const runtime: ObservationRuntime = {
		...base,
		async git(root, args, signal) {
			if (args[0] === "diff" && args.includes("--cached")) throw new GitCommandError("git diff exited 128: injected", 128);
			return base.git(root, args, signal);
		},
	};
	try {
		append(x.f, "tests/a.test.ts", "it.only(\"x\", () => {});");
		const { s, alerts } = await run(x, runtime);
		assert.equal(s.evidence?.index.status, "unavailable");
		assert.deepEqual(summary(alerts), ["WARN coverage-incomplete", "HARD test-focus"]);
		assert.deepEqual(alerts[0].evidence, ["index: git diff exited 128: injected", "rules not checked: suppression-comment, test-focus, deleted-test"]);
	} finally { x.f.close(); }
});

test("incomplete: git unavailable is coverage incomplete for every generic rule, never clean", async () => {
	const x = scratch();
	const base = clock();
	const runtime: ObservationRuntime = { ...base, git: async () => { throw new Error("git missing"); } };
	try {
		const s = await readOnce(x.f, runtime);
		const mission = (await readOnce(x.f)).mission!;
		const alerts = evaluate(s, mission, x.launch);
		assert.deepEqual(summary(alerts), ["WARN coverage-incomplete"]);
		assert.equal(alerts[0].evidence[1], "rules not checked: branch-changed, base-not-ancestor, nonlinear-history, suppression-comment, test-focus, deleted-test");
	} finally { x.f.close(); }
});

test("incomplete: a binary file with a JS extension cannot be scanned and is reported", async () => {
	const x = scratch();
	try {
		writeFileSync(path.join(x.f.root, "src/blob.js"), Buffer.from([0x2f, 0x2f, 0, 1, 2]));
		const sha = land(x.f, "commit", () => {});
		const { alerts } = await run(x);
		assert.deepEqual(summary(alerts), ["WARN coverage-incomplete"]);
		assert.deepEqual(alerts[0].evidence, [`commit ${sha} "src/blob.js": binary`, "rules not checked: suppression-comment"]);
	} finally { x.f.close(); }
});
