import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { evaluate } from "../src/watch/enforcer.js";
import { clock, Fixture, readOnce, T } from "./fixtures/loop-state.ts";

const SEAMS = ["commit", "index", "worktree"] as const;
type Seam = typeof SEAMS[number];
function write(f: Fixture, rel: string, text: string) {
	mkdirSync(path.dirname(path.join(f.root, rel)), { recursive: true });
	writeFileSync(path.join(f.root, rel), text);
}
function configure(f: Fixture, extra: Record<string, unknown>) {
	const file = path.join(f.root, ".ralph/mission.json");
	const old = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...old, git: { baseCommit: f.git("rev-parse", "HEAD") }, ...extra }));
	f.commit("policy", T("09:30"));
}
function fixture(extra: Record<string, unknown> = {}, items = [{ id: "A", passes: false }, { id: "B", passes: false }]) {
	const f = new Fixture(items, { blocker: true });
	write(f, "lib/a.ts", "export const a = 1;\n");
	write(f, "spec/a.test.ts", 'check(1);\n');
	write(f, "policy/shape.json", '{"data":{"rule":2}}\n');
	write(f, "policy/anti.json", '{"rule":2}\n');
	write(f, "policy/files.json", '["lib/a.ts"]\n');
	f.commit("files", T("09:15"));
	configure(f, extra);
	return f;
}
function land(f: Fixture, seam: Seam, change: () => void, subject = "inject") {
	change(); if (seam === "worktree") return null;
	f.git("add", "-A"); return seam === "index" ? null : f.commit(subject, T("10:00"));
}
async function alerts(f: Fixture) {
	const s = await readOnce(f); assert.ok(s.mission, JSON.stringify(s.issues));
	return { s, alerts: evaluate(s, s.mission, { branch: f.git("symbolic-ref", "--short", "HEAD") }) };
}
function has(found: Awaited<ReturnType<typeof alerts>>, rule: string, level = "HARD") {
	assert.ok(found.alerts.some(a => a.rule === rule && a.level === level), JSON.stringify(found.alerts));
}
const SHAPE = { baselines: [{ name: "shape", file: "policy/shape.json", schema: { kind: "counter-map", pointer: "/data" } }], rules: { "shape-count-rise": "hard" } };
for (const seam of SEAMS) test(`shape count rise and equal-count control (${seam})`, async () => {
	const f = fixture(SHAPE);
	try {
		land(f, seam, () => write(f, "policy/shape.json", '{"data":{"rule":3}}\n'));
		has(await alerts(f), "shape-count-rise");
	} finally { f.close(); }
	const clean = fixture(SHAPE);
	try {
		land(clean, seam, () => write(clean, "policy/shape.json", '{ "data": {"rule":2} }\n'));
		assert.deepEqual((await alerts(clean)).alerts, []);
	} finally { clean.close(); }
});

for (const [name, file, kind, pointer, rule, dirty, clean] of [
	["shape", "shape.json", "counter-map", "/data", "shape-new-entry", '{"data":{"rule":2,"new":0}}', '{"data":{"rule":1}}'],
	["shape", "files.json", "entry-array", "", "shape-new-entry", '["lib/a.ts","lib/new.ts"]', '["lib/a.ts"]'],
	["anti-slop", "anti.json", "counter-map", "", "anti-slop-rise", '{"rule":3}', '{"rule":1}'],
	["anti-slop", "anti.json", "counter-map", "", "anti-slop-rise", '{"rule":2,"new":0}', '{}'],
] as const) for (const seam of SEAMS) test(`${rule} ${dirty} and clean control (${seam})`, async () => {
	const config = { baselines: [{ name, file: `policy/${file}`, schema: { kind, pointer } }], rules: { [rule]: "hard" } };
	for (const [text, bad] of [[dirty, true], [clean, false]] as const) {
		const f = fixture(config);
		try { land(f, seam, () => write(f, `policy/${file}`, text)); const found = await alerts(f); if (bad) has(found, rule); else assert.deepEqual(found.alerts, []); }
		finally { f.close(); }
	}
});
for (const seam of SEAMS) for (const mutation of ["add", "modify", "delete"] as const) test(`protected exact paths and prefixes ${mutation} (${seam})`, async () => {
	for (const protectedPath of ["policy/shape.json", "db/migrations/nested/001.sql", "config/lint.json", "gates/check.sh", "packages/core/package.json", "scripts/verify.ts", "schema/root.json", "db/schema.sql", "lockfile.json"]) {
		const f = fixture();
		try {
			if (mutation !== "add") { write(f, protectedPath, "old\n"); f.commit("guarded file", T("09:35")); }
			configure(f, { protected: { paths: [protectedPath], prefixes: ["db/migrations"] }, rules: { "protected-path": "hard" } });
			land(f, seam, () => mutation === "delete" ? rmSync(path.join(f.root, protectedPath)) : write(f, protectedPath, "new\n"));
			has(await alerts(f), "protected-path");
		} finally { f.close(); }
	}
	const clean = fixture({ protected: { prefixes: ["db/migrations"] }, rules: { "protected-path": "hard" } });
	try { land(clean, seam, () => write(clean, "db/migrations-other/new.sql", "ok\n")); assert.deepEqual((await alerts(clean)).alerts, []); } finally { clean.close(); }
});

const SOURCE_RULES = { scope: { sourceGlobs: ["lib/**"] }, rules: { "pass-without-source": "hard", "source-without-item-pass": "hard", "item-order": "hard" } };
function pass(f: Fixture, ...ids: string[]) { f.items = f.items.map(i => ids.includes(i.id!) ? { ...i, passes: true } : i); f.writeBundle(); }
for (const [name, ids, source, rule] of [
	["multiple pass", ["A", "B"], true, "multiple-item-pass"],
	["pass no source", ["A"], false, "pass-without-source"],
	["source no pass", [], true, "source-without-item-pass"],
	["item out of order", ["B"], true, "item-order"],
] as const) test(`${name}: violating commit and single ordered source pass control`, async () => {
	const f = fixture(SOURCE_RULES);
	try { land(f, "commit", () => { pass(f, ...ids); if (source) write(f, "lib/a.ts", "export const a = 2;\n"); }); has(await alerts(f), rule); }
	finally { f.close(); }
	const clean = fixture(SOURCE_RULES);
	try { land(clean, "commit", () => { pass(clean, "A"); write(clean, "lib/a.ts", "export const a = 2;\n"); }); assert.deepEqual((await alerts(clean)).alerts, []); }
	finally { clean.close(); }
});
for (const seam of ["index", "worktree"] as const) test(`unfinished source edit raises no pass rule (${seam})`, async () => {
	const f = fixture(SOURCE_RULES);
	try { land(f, seam, () => write(f, "lib/a.ts", "export const a = 2;\n")); assert.deepEqual((await alerts(f)).alerts, []); } finally { f.close(); }
});
for (const receipt of ["A", "B"]) test(`configured receipt ${receipt} can pass without source`, async () => {
	const f = fixture({ scope: { sourceGlobs: ["lib/**"], receiptItems: [receipt] }, rules: { "pass-without-source": "hard" } });
	try { land(f, "commit", () => pass(f, receipt)); assert.deepEqual((await alerts(f)).alerts, []); } finally { f.close(); }
});
function approve(f: Fixture, sha: string) {
	const config = JSON.parse(readFileSync(path.join(f.root, ".ralph/mission.json"), "utf8"));
	configure(f, { git: { ...config.git, parentCommits: [{ sha, reason: "Owner maintenance" }] } });
}
test("parent approval matches the exact SHA, not descendants or unlisted commits", async () => {
	const f = fixture(SOURCE_RULES);
	try {
		const approved = land(f, "commit", () => write(f, "lib/a.ts", "export const a = 2;\n"))!;
		approve(f, approved);
		let found = await alerts(f);
		assert.deepEqual(found.alerts.map(a => [a.level, a.rule, a.commit]), [["INFO", "approved-parent-commit", approved]]);
		assert.ok(found.alerts[0].evidence.includes("Owner maintenance"));
		const descendant = land(f, "commit", () => write(f, "lib/a.ts", "export const a = 3;\n"));
		found = await alerts(f); has(found, "source-without-item-pass");
		assert.equal(found.alerts.find(a => a.rule === "source-without-item-pass")?.commit, descendant);
	} finally { f.close(); }
});
test("approved multi-pass commit still has item-pass classification but is workflow-exempt", async () => {
	const f = fixture(SOURCE_RULES);
	try { const sha = land(f, "commit", () => pass(f, "A", "B"))!; approve(f, sha); const found = await alerts(f); assert.equal(found.s.git?.commits?.find(c => c.sha === sha)?.kind, "item-pass"); assert.deepEqual(found.alerts.map(a => a.rule), ["approved-parent-commit"]); } finally { f.close(); }
});

for (const seam of SEAMS) for (const mutation of ["insert", "remove", "unpass", "title", "field", "reorder", "document"] as const) test(`item mutation ${mutation} (${seam}) is WARN with observable snapshot diff`, async () => {
	const f = fixture({}, [{ id: "A", passes: true }, { id: "B", passes: false }]);
	try {
		land(f, seam, () => {
			if (mutation === "insert") f.items.push({ id: "C", passes: false });
			if (mutation === "remove") f.items.shift();
			if (mutation === "unpass") f.items[0].passes = false;
			if (mutation === "title") f.items[0].title = "changed";
			if (mutation === "reorder") f.items.reverse();
			f.writeBundle();
			if (mutation === "field" || mutation === "document") {
				const file = path.join(f.root, ".ralph/items.json"), doc = JSON.parse(readFileSync(file, "utf8"));
				if (mutation === "field") doc.items[0].custom = "changed"; else doc.custom = "changed";
				writeFileSync(file, JSON.stringify(doc));
			}
		});
		const found = await alerts(f); has(found, "items-beyond-pass-flips", "WARN");
		const evidence = seam === "commit" ? found.s.evidence!.commits[f.git("rev-parse", "HEAD")] : found.s.evidence![seam];
		assert.equal(evidence.status, "fresh");
		if (evidence.status === "fresh") { assert.ok(evidence.policy.items && !("unavailable" in evidence.policy.items)); if (mutation === "insert") assert.deepEqual(evidence.policy.items.inserted, ["C"]); if (mutation === "unpass") assert.deepEqual(evidence.policy.items.unpassed, ["A"]); }
	} finally { f.close(); }
});
test("blocker may change only its own regression notes; pass flip remains clean", async () => {
	const f = fixture();
	try { land(f, "commit", () => { f.items[0].regression_notes = "Gate failed"; f.writeBundle(); }, "blocked(A): gate"); assert.deepEqual((await alerts(f)).alerts, []); } finally { f.close(); }
	const clean = fixture();
	try { land(clean, "commit", () => pass(clean, "A")); assert.deepEqual((await alerts(clean)).alerts, []); } finally { clean.close(); }
});
for (const seam of SEAMS) test(`test edit arguments-only exemption (${seam})`, async () => {
	for (const [text, warn] of [["check(2);\n", false], ["check(other(2));\n", false], ["check(2);\nconst added = 1;\n", true], ["other(2);\n", true], ["// changed\ncheck(1);\n", true]] as const) {
		const f = fixture({ scope: { testGlobs: ["spec/**"] }, testEdit: { mode: "arguments-only", functions: ["check"] } });
		try { land(f, seam, () => write(f, "spec/a.test.ts", text)); const found = await alerts(f); if (warn) has(found, "test-edit", "WARN"); else assert.deepEqual(found.alerts, []); } finally { f.close(); }
	}
});
for (const seam of SEAMS) test(`WARN rules other areas, large diff and bundle state (${seam})`, async () => {
	const f = fixture({ otherAreas: [{ name: "client", globs: ["client/**"] }], thresholds: { authority: "Test owner", largeDiffPaths: 1, largeDiffLines: 2 }, rules: { "other-area": "warn", "large-diff": "warn" } });
	try { land(f, seam, () => { write(f, "client/view.txt", "a\nb\nc\n"); write(f, ".ralph/notes.txt", "note\n"); }); const found = await alerts(f); for (const rule of ["other-area", "large-diff", "bundle-state-edit"]) has(found, rule, "WARN"); assert.equal(found.alerts.filter(a => a.level === "HARD").length, 0); } finally { f.close(); }
	const clean = fixture({ thresholds: { authority: "Test owner", largeDiffPaths: 1, largeDiffLines: 2 }, rules: { "large-diff": "warn" } });
	try { land(clean, seam, () => write(clean, "new.txt", "a\nb\n")); assert.deepEqual((await alerts(clean)).alerts, []); } finally { clean.close(); }
});

test("probe stdout contracts strictly parse counts and root-relative importer paths", async () => {
	const { parseMeasureOutput, parseImporterOutput } = await import("../src/watch/probes.js");
	assert.deepEqual(parseMeasureOutput('{"shape":2}'), { kind: "ok", value: { shape: 2 } });
	for (const text of ["log\n{}", "[]", '{"a":-1}', '{"a":1.5}', '{"a":"2"}', "null"]) assert.equal(parseMeasureOutput(text).kind, "unavailable", text);
	assert.deepEqual(parseImporterOutput('["lib/a.ts","spec/a.test.ts"]'), { kind: "ok", value: ["lib/a.ts", "spec/a.test.ts"] });
	for (const text of ["log\n[]", "{}", '["/absolute"]', '["../escape"]', '["a/../b"]', '["a\\\\b"]', '[1]', '["a\\u0000b"]']) assert.equal(parseImporterOutput(text).kind, "unavailable", text);
});
test("measure results are injected, evaluated only on worktree, and unavailable is WARN", async () => {
	const f = fixture({ measure: { command: ["node", "-e", "throw Error('must not run')"], start: { shape: 2 } }, rules: { "debt-measure-rise": "hard" } });
	try {
		const { s } = await alerts(f);
		const { parseMeasureOutput } = await import("../src/watch/probes.js");
		for (const [text, expected] of [['{"shape":3}', ["HARD", "debt-measure-rise"]], ['{"shape":2}', null], ["not JSON", ["WARN", "measure-unavailable"]], ['{}', ["WARN", "measure-unavailable"]]] as const) {
			const found = evaluate(s, s.mission!, { branch: f.git("symbolic-ref", "--short", "HEAD") }, { measure: parseMeasureOutput(text) });
			assert.deepEqual(found.map(a => [a.level, a.rule]), expected ? [expected] : []);
			assert.ok(found.every(a => a.commit === null));
		}
	} finally { f.close(); }
});
const SCOPE = { scope: { sourceGlobs: ["lib/**"], items: [{ id: "A", allowedPaths: ["lib/a.ts"], targets: ["lib/target.ts"] }], importerCommand: ["node", "-e", "throw Error('must not run')"] }, rules: { "outside-item-and-importers": "warn" } };
for (const seam of SEAMS) test(`scope allows item paths, targets and injected importers (${seam})`, async () => {
	const f = fixture(SCOPE); f.state(true, T("09:45"));
	try {
		land(f, seam, () => { write(f, "lib/target.ts", "export {};\n"); write(f, "lib/importer.ts", "export {};\n"); write(f, "lib/outside.ts", "export {};\n"); if (seam === "commit") pass(f, "A"); });
		const { s } = await alerts(f);
		const found = evaluate(s, s.mission!, { branch: f.git("symbolic-ref", "--short", "HEAD") }, { importers: { A: { kind: "ok", value: ["lib/importer.ts"] } } });
		assert.deepEqual(found.map(a => [a.level, a.rule]), [["WARN", "outside-item-and-importers"]]);
		assert.ok(found[0].evidence.join("\n").includes("lib/outside.ts"));
		assert.ok(!found[0].evidence.join("\n").includes("lib/importer.ts"));
		const missing = evaluate(s, s.mission!, { branch: f.git("symbolic-ref", "--short", "HEAD") });
		assert.ok(missing.some(a => a.rule === "importer-check-unavailable" && a.level === "WARN"));
		assert.equal(missing.some(a => a.rule === "outside-item-and-importers"), false);
	} finally { f.close(); }
});
test("receipt scope warns for source changes and permits a bundle-only pass", async () => {
	for (const [file, bad] of [[null, false], ["lib/a.ts", true], ["lib/outside.ts", true]] as const) {
		const f = fixture({ scope: { sourceGlobs: ["lib/**"], receiptItems: ["A"], items: [{ id: "A", allowedPaths: ["lib/a.ts"] }] }, rules: { "receipt-item-source-scope": "warn" } });
		try { land(f, "commit", () => { pass(f, "A"); if (file) write(f, file, "export {};\n"); }); const found = await alerts(f); if (bad) has(found, "receipt-item-source-scope", "WARN"); else assert.deepEqual(found.alerts, []); } finally { f.close(); }
	}
});

for (const [name, file, dirty, rule] of [
	["suppression", "lib/a.ts", "// @ts-ignore\nexport const a = 2;\n", "suppression-comment"],
	["skip", "spec/a.test.ts", 'check.skip(1);\n', "test-focus"],
	["only", "spec/a.test.ts", 'check.only(1);\n', "test-focus"],
	["shape", "policy/shape.json", '{"data":{"rule":3}}', "shape-count-rise"],
	["anti", "policy/anti.json", '{"rule":3}', "anti-slop-rise"],
	["protected", "policy/files.json", '[]', "protected-path"],
	["deleted test", "spec/a.test.ts", null, "deleted-test"],
] as const) for (const seam of SEAMS) test(`approved parent retains safety ${name} (${seam})`, async () => {
	const f = fixture({
		scope: { sourceGlobs: ["lib/**"], testGlobs: ["spec/**"] },
		baselines: [...SHAPE.baselines, { name: "anti-slop", file: "policy/anti.json", schema: { kind: "counter-map", pointer: "" } }],
		protected: { paths: ["policy/files.json"] },
		rules: { ...SHAPE.rules, "anti-slop-rise": "hard", "source-without-item-pass": "hard", "protected-path": "hard" },
	});
	try {
		if (seam !== "commit") { const sha = land(f, "commit", () => write(f, "lib/a.ts", "export const a = 2;\n"))!; approve(f, sha); }
		const sha = land(f, seam, () => dirty === null ? rmSync(path.join(f.root, file)) : write(f, file, dirty));
		if (sha) approve(f, sha);
		const found = await alerts(f); has(found, rule);
		assert.equal(found.alerts.find(a => a.rule === rule)?.commit, sha);
		assert.equal(found.alerts.filter(a => a.rule === "source-without-item-pass").length, 0);
	} finally { f.close(); }
	const clean = fixture({ ...SOURCE_RULES });
	try { const sha = land(clean, "commit", () => write(clean, "lib/a.ts", "export const a = 2;\n"))!; approve(clean, sha); assert.deepEqual((await alerts(clean)).alerts.map(a => a.rule), ["approved-parent-commit"]); } finally { clean.close(); }
});
for (const seam of SEAMS) test(`plain task ignores item rules and unconfigured project policies (${seam})`, async () => {
	const f = new Fixture([{ id: "A", passes: false }], { plain: true });
	try {
		configure(f, {});
		land(f, seam, () => { pass(f, "A"); write(f, "db/migrations/new.sql", "x\n".repeat(1000)); write(f, "policy/debt.json", '{"new":999}'); });
		assert.deepEqual((await alerts(f)).alerts, []);
	} finally { f.close(); }
});
test("minimal bundle has no source/debt/protected/area/large-diff project policy", async () => {
	const f = fixture();
	try { land(f, "commit", () => { write(f, "lib/a.ts", "export const a = 2;\n".repeat(1000)); write(f, "policy/shape.json", '{"data":{"new":999}}'); }); assert.deepEqual((await alerts(f)).alerts, []); } finally { f.close(); }
});
for (const seam of SEAMS) for (const mutation of ["delete", "invalid"] as const) test(`debt ${mutation} is incomplete, never zero (${seam})`, async () => {
	const f = fixture(SHAPE);
	try {
		const { loadMission } = await import("../src/watch/config.js"); const mission = await loadMission(f.root);
		land(f, seam, () => mutation === "delete" ? rmSync(path.join(f.root, "policy/shape.json")) : write(f, "policy/shape.json", "invalid JSON"));
		const { openLoop } = await import("../src/watch/loop-state.js"); const reader = openLoop(f.root, { mission });
		try { const s = await reader.read(); const found = evaluate(s, mission, { branch: f.git("symbolic-ref", "--short", "HEAD") }); assert.deepEqual(found.map(a => [a.level, a.rule]), [["WARN", "coverage-incomplete"]]); assert.ok(found[0].evidence.join("\n").includes("policy/shape.json")); }
		finally { await reader.close(); }
	} finally { f.close(); }
});

for (const seam of SEAMS) test(`WARN levels are configurable; parent approval does not exempt review rules (${seam})`, async () => {
	const f = fixture({ protected: { paths: ["lib/a.ts"] }, rules: { "protected-path": "warn" } });
	try { const sha = land(f, seam, () => write(f, "lib/a.ts", "export const a = 2;\n")); if (sha) approve(f, sha); has(await alerts(f), "protected-path", "WARN"); } finally { f.close(); }
});
test("policy observation preserves index bytes and identity after same-content rewrites", async () => {
	const { statSync } = await import("node:fs");
	const { openLoop } = await import("../src/watch/loop-state.js");
	const f = fixture();
	try {
		f.items.push({ id: "C", passes: false }); f.writeBundle();
		const index = path.join(f.root, ".git/index"), bytes = readFileSync(index), stamp = statSync(index, { bigint: true });
		const reader = openLoop(f.root);
		try { const s = await reader.read(); assert.equal(s.issues.some(issue => issue.kind === "concurrent"), false); assert.deepEqual(readFileSync(index), bytes); assert.equal(statSync(index, { bigint: true }).ino, stamp.ino); } finally { await reader.close(); }
	} finally { f.close(); }
});
test("binary line counts are incomplete; large diff stays off without configured thresholds", async () => {
	const f = fixture({ thresholds: { authority: "Test owner", largeDiffLines: 2 }, rules: { "large-diff": "warn" } });
	try { writeFileSync(path.join(f.root, "binary.dat"), Buffer.from([0, 1, 2])); const found = await alerts(f); has(found, "coverage-incomplete", "WARN"); assert.equal(found.alerts.some(a => a.rule === "large-diff"), false); } finally { f.close(); }
	const off = fixture();
	try { write(off, "large.txt", "x\n".repeat(1000)); assert.deepEqual((await alerts(off)).alerts, []); } finally { off.close(); }
});
test("configured project rules report missing seam evidence and never infer clean", async () => {
	const f = fixture(SHAPE);
	try {
		const { s } = await alerts(f);
		const missing = { ...s, evidence: { ...s.evidence!, index: { status: "unavailable" as const, error: "injected failure" } } };
		const found = evaluate(missing, s.mission!, { branch: f.git("symbolic-ref", "--short", "HEAD") });
		assert.ok(found.some(a => a.rule === "coverage-incomplete" && a.evidence.join("\n").includes("shape-count-rise")));
		assert.equal(found.some(a => a.level === "HARD"), false);
	} finally { f.close(); }
});

test("approved HEAD exempts item order, receipt scope and importer scope only", async () => {
	const f = fixture({
		scope: { sourceGlobs: ["lib/**"], receiptItems: ["B"], items: [{ id: "B", allowedPaths: ["lib/a.ts"] }], importerCommand: ["node", "-e", "throw Error('must not run')"] },
		rules: { "item-order": "warn", "receipt-item-source-scope": "warn", "outside-item-and-importers": "warn" },
	});
	try {
		const sha = land(f, "commit", () => { pass(f, "B"); write(f, "lib/outside.ts", "export {};\n"); })!;
		const { s } = await alerts(f);
		const unapproved = evaluate(s, s.mission!, { branch: f.git("symbolic-ref", "--short", "HEAD") }, { importers: { B: { kind: "ok", value: [] } } });
		assert.deepEqual(unapproved.map(a => a.rule).sort(), ["item-order", "outside-item-and-importers", "receipt-item-source-scope"].sort());
		const file = path.join(f.root, ".ralph/mission.json"), doc = JSON.parse(readFileSync(file, "utf8"));
		doc.git.parentCommits = [{ sha, reason: "Owner receipt" }]; writeFileSync(file, JSON.stringify(doc));
		const approved = await alerts(f);
		assert.equal(approved.s.git?.head, sha);
		assert.deepEqual(approved.alerts.map(a => [a.level, a.rule, a.commit]), [["INFO", "approved-parent-commit", sha]]);
	} finally { f.close(); }
});

// Round 1: stat-only dirtiness must not prove a protected-path violation.
test("identical-byte protected rewrite is clean; real edit is HARD without index writes", async () => {
	const { utimesSync, statSync } = await import("node:fs");
	const f = fixture({ protected: { paths: ["policy/shape.json"] }, rules: { "protected-path": "hard" } });
	try {
		const file = path.join(f.root, "policy/shape.json"), index = path.join(f.root, ".git/index");
		const bytes = readFileSync(file), indexBytes = readFileSync(index), ino = statSync(index).ino;
		writeFileSync(file, bytes); utimesSync(file, new Date(), new Date(Date.now() + 5000));
		assert.equal(f.git("ls-files", "-m", "-z"), "");
		assert.deepEqual((await alerts(f)).alerts, []);
		assert.deepEqual(readFileSync(index), indexBytes); assert.equal(statSync(index).ino, ino);
		writeFileSync(file, '{"data":{"rule":3}}\n');
		assert.ok(f.git("ls-files", "-m", "-z").includes("policy/shape.json"));
		has(await alerts(f), "protected-path");
		assert.deepEqual(readFileSync(index), indexBytes); assert.equal(statSync(index).ino, ino);
	} finally { f.close(); }
});

test("managed bundle launch and steer files are runtime state, not bundle edits", async () => {
	const f = fixture();
	try {
		for (const file of ["launch-9b9fe773-a490-413a-9e0b-33515c5f0ad1.json", "launch-9b9fe773-a490-413a-9e0b-33515c5f0ad1.json.123.tmp", "launch.lock", "steer/request.txt", "steer/nested/queued.txt", "watch-host.json.123.tmp", "driver.json.123.tmp"]) write(f, `.ralph/${file}`, "runtime\n");
		assert.deepEqual((await alerts(f)).alerts, []);
		write(f, ".ralph/author-notes.json", "{}\n"); has(await alerts(f), "bundle-state-edit", "WARN");
	} finally { f.close(); }
});
for (const seam of ["index", "worktree"] as const) test(`current item regression notes alone are allowed before blocker commit (${seam})`, async () => {
	const f = fixture(); f.state(true, T("09:45"));
	try {
		land(f, seam, () => { f.items[0].regression_notes = "Gate failed"; f.writeBundle(); });
		assert.deepEqual((await alerts(f)).alerts, []);
		land(f, seam, () => { f.items[0].title = "Changed title"; f.writeBundle(); });
		has(await alerts(f), "items-beyond-pass-flips", "WARN");
	} finally { f.close(); }
});

for (const seam of ["index", "worktree"] as const) test(`one whole-file test diff supplies both sides and argument classification (${seam})`, async () => {
	const f = fixture({ scope: { testGlobs: ["spec/**"] }, testEdit: { mode: "arguments-only", functions: ["check"] } });
	try {
		land(f, seam, () => write(f, "spec/a.test.ts", "check(2);\n"));
		const base = clock(); let diffs = 0;
		const s = await readOnce(f, { ...base, git(root, args, signal) {
			if (args.includes("-U2147483647") && args.at(-1) === "spec/a.test.ts") diffs++;
			return base.git(root, args, signal);
		} });
		assert.equal(diffs, 1);
		const found = s.evidence![seam]; assert.equal(found.status, "fresh");
		if (found.status === "fresh") assert.deepEqual(found.policy.oldLines["spec/a.test.ts"], ["check(1);"]);
		assert.deepEqual(evaluate(s, s.mission!, { branch: f.git("symbolic-ref", "--short", "HEAD") }), []);
	} finally { f.close(); }
});
test("empty-tree hash failure makes only its commit evidence unavailable", async () => {
	const f = fixture();
	try {
		land(f, "commit", () => write(f, "lib/a.ts", "// @ts-ignore\nexport const a = 2;\n"));
		const base = clock(); let failed = false;
		const s = await readOnce(f, { ...base, git(root, args, signal) {
			if (args[0] === "hash-object" && !failed) { failed = true; throw new Error("injected hash-object failure"); }
			return base.git(root, args, signal);
		} });
		assert.ok(failed); assert.ok(s.git); assert.ok(s.evidence);
		const commits = s.git.commits!;
		assert.equal(s.evidence.commits[commits[0].sha].status, "unavailable");
		assert.equal(s.evidence.commits[commits[1].sha].status, "fresh");
		assert.equal(s.evidence.index.status, "fresh"); assert.equal(s.evidence.worktree.status, "fresh");
		const found = { s, alerts: evaluate(s, s.mission!, { branch: f.git("symbolic-ref", "--short", "HEAD") }) };
		has(found, "coverage-incomplete", "WARN"); has(found, "suppression-comment");
	} finally { f.close(); }
});
