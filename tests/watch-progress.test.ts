import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { latestCard, parseProgress } from "../src/watch/progress.ts";

test("heading-only entries have optional fields and preserve raw", () => {
	const raw = "# P0 blocked: preview proof coverage\n\n## K15 BLOCKED (2026-09-30)";
	const cards = parseProgress(raw);
	assert.equal(cards.length, 2);
	assert.deepEqual(cards[0], {
		index: 0, id: "P0", outcome: "blocked", title: "preview proof coverage",
		date: null, raw: "# P0 blocked: preview proof coverage\n\n", fields: null, resolvedBy: null,
	});
	assert.equal(cards[1].id, "K15");
	assert.equal(cards[1].title, "");
	assert.equal(cards[1].date, "2026-09-30");
	assert.equal(cards[1].fields, null);
	assert.equal(latestCard(cards), cards[1]);
	assert.equal(latestCard([]), null);
});

test("extracts card rows from bullets, continuation lines and proof fences", () => {
	const raw = [
		"# X01 blocked: gate repair (2026-09-30)",
		"- Selected the parser because the gate failed. More detail.",
		"- Failing command: `npm run verify` exit 2.",
		"- Exact error: `missing fixture`.",
		"- Diagnosis: The fixture was absent. More detail.",
		"- Repair attempts: Added the fixture.",
		"  Then reran the gate.",
		"- Question for parent: Approve the fixture?",
		"- Remaining steps not run: build and publish.",
		"- Assumption: Inputs are append-only.",
		"- Evidence: /tmp/generic/check.log and proof.diff",
		"- Before/after: warnings 3 -> 0; errors 2 → 0.",
		"- git diff --stat: 2 files, 8 insertions and 1 deletion.",
		"```text", "IDENTICAL alpha", "IDENTICAL alpha", "CHANGED beta", "```",
	].join("\n");
	const fields = parseProgress(raw)[0].fields;
	assert.ok(fields);
	assert.deepEqual(fields.failed, { cmd: "verify", exit: 2, error: "missing fixture." });
	assert.equal(fields.cause, "The fixture was absent.");
	assert.equal(fields.tried, "Added the fixture.");
	assert.equal(fields.decide, "Approve the fixture?");
	assert.equal(fields.why, "Selected the parser because the gate failed.");
	assert.deepEqual(fields.notRun, ["build", "publish"]);
	assert.deepEqual(fields.assumed, ["Inputs are append-only."]);
	assert.deepEqual(fields.evidence, ["/tmp/generic/check.log", "proof.diff"]);
	assert.deepEqual(fields.counts, [{ label: "warnings", from: "3", to: "0" }, { label: "errors", from: "2", to: "0" }]);
	assert.equal(fields.diff, "2 files, 8 insertions and 1 deletion");
	assert.deepEqual(fields.proof, { identical: 1, total: 2 });
});

test("checks collect command exits in order, including reruns and exit=N fences", () => {
	const cards = parseProgress([
		"# X02 passed: gates",
		"- Checks: `npm run verify` exit 1; rerun exit 0: 24 tests passed; npm test exited 0.",
		"- Checks: `npm run verify` exit code 0.",
		"Exact executed gate/action command exits and seconds:",
		"```text", "types exit=0 seconds=2 command=npx tsc --noEmit", "test exit=0 seconds=1 command=npm test", "```",
	].join("\n"));
	assert.deepEqual(cards[0].fields?.checks, [
		{ cmd: "verify", exits: [1, 0, 0], detail: "24 tests passed" },
		{ cmd: "test", exits: [0, 0], detail: null },
		{ cmd: "types", exits: [0], detail: null },
	]);
});

test("blocked cards resolve only to the next later pass with the same id", () => {
	const cards = parseProgress("# X blocked: first\n# Y passed: unrelated\n# X blocked: again\n# X passed: fixed\n# X passed: later\n# X blocked: new failure\n# Z blocked: unresolved");
	assert.deepEqual(cards.map((c) => c.resolvedBy), [3, null, 3, null, null, null, null]);
});

const sample = readFileSync(new URL("./fixtures/progress-sample.md", import.meta.url), "utf8");

test("parses a synthesized 15-entry sample with ids, outcomes and dates", () => {
	const cards = parseProgress(sample);
	assert.equal(cards.length, 15);
	assert.deepEqual(cards.map((c) => c.id), ["P0", "G01", "G02", "G02", "G03", "G04", "G05", "G06", "G06", "G07", "G08", "G09", "G10", "G11", "G12"]);
	assert.deepEqual(cards.map((c) => c.outcome), ["blocked", "passed", "blocked", "passed", "passed", "passed", "passed", "blocked", "passed", "passed", "passed", "passed", "passed", "passed", "blocked"]);
	assert.deepEqual(cards.map((c) => c.date), [null, "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-28", "2026-09-29", "2026-09-29", "2026-09-30", "2026-09-30"]);
	assert.ok(cards.every((c) => c.fields !== null));
	assert.equal(cards.map((c) => c.raw).join(""), sample);
	assert.equal(cards[2].resolvedBy, 3);
	assert.equal(cards[7].resolvedBy, 8);
	// The entry gives a reason but names no unexecuted steps.
	assert.deepEqual(cards[14].fields?.notRun, []);
	// The failed-command description and the table describe one release execution.
	assert.deepEqual(cards[14].fields?.checks.map((c) => [c.cmd, c.exits]), [["types", [0]], ["tests", [0]], ["release", [1]]]);
});

test("empty and whitespace input return no cards", () => {
	for (const text of ["", " \t\n\r\n"]) assert.deepEqual(parseProgress(text), []);
});

test("malformed entries retain raw with no card fields", () => {
	const raw = "# unfinished handoff\nnot a recognized label\n- random prose\n";
	const card = parseProgress(raw)[0];
	assert.equal(card.raw, raw);
	assert.equal(card.fields, null);
	assert.equal(card.id, null);
	assert.equal(card.outcome, "unknown");
});

test("text without a heading or before the first heading is kept as unknown raw", () => {
	const prefix = "Unstructured notes\n- Diagnosis: not an entry\n\n";
	assert.deepEqual(parseProgress(prefix)[0], {
		index: 0, id: null, outcome: "unknown", title: "", date: null,
		raw: prefix, fields: null, resolvedBy: null,
	});
	const cards = parseProgress(`${prefix}# X passed: done`);
	assert.equal(cards.length, 2);
	assert.equal(cards[0].raw, prefix);
	assert.equal(cards[0].fields, null);
	assert.equal(cards[1].index, 1);
});

test("partial trailing entry keeps its raw without needing a final newline", () => {
	const raw = "# X blocked: unfinished\n- Diagnosis: Partially wri";
	assert.equal(parseProgress(raw)[0].raw, raw);
	assert.equal(parseProgress(raw)[0].fields?.cause, "Partially wri");
});

test("CRLF input gives the same cards as LF input", () => {
	assert.deepEqual(parseProgress(sample.replace(/\n/g, "\r\n")), parseProgress(sample));
});

test("unclosed fences keep raw and do not split headings inside code", () => {
	const raw = "# X passed: proof\n  ```text\nIDENTICAL data\n# Y blocked: this is code";
	const cards = parseProgress(raw);
	assert.equal(cards.length, 1);
	assert.equal(cards[0].raw, raw);
	assert.deepEqual(cards[0].fields?.proof, { identical: 1, total: 1 });
});

for (const pattern of ["a.", "a-", "/a"]) {
	test(`multi-line 1 MB ${pattern} entry parses within one second and keeps full raw`, (t) => {
		const line = pattern.repeat(4_000) + "\n";
		const raw = "# X passed: large input\n" + line.repeat(125);
		const started = performance.now();
		const cards = parseProgress(raw);
		const elapsed = performance.now() - started;
		t.diagnostic(`${pattern} parse: ${elapsed.toFixed(3)} ms`);
		assert.ok(elapsed < 1_000, `${pattern} parse took ${elapsed.toFixed(3)} ms`);
		assert.equal(cards[0].raw, raw);
		assert.equal(cards[0].fields, null);
	});
}

test("ANSI and control characters are stripped from parsed strings but kept in raw", () => {
	const raw = "# \x1b[31mX\x1b[0m blocked: \x00gate\n- Diagnosis: \x1b[31mBad\x1b[0m\x00 input.\n- Evidence: /tmp/\x1b[32mproof.log\x1b[0m";
	const card = parseProgress(raw)[0];
	assert.equal(card.raw, raw);
	assert.equal(card.id, "X");
	assert.equal(card.title, "gate");
	assert.equal(card.fields?.cause, "Bad input.");
	assert.deepEqual(card.fields?.evidence, ["/tmp/proof.log"]);
});

test("commands use generic path shortening and cap display names", () => {
	const fields = parseProgress("# X blocked: paths\n- Failing command: `/opt/work/scripts/verify.sh` exit 1.\n- Checks: `" + "x".repeat(100) + "` exit 0.")[0].fields;
	assert.equal(fields?.failed?.cmd, "verify.sh");
	assert.equal(fields?.checks[0].cmd, "x".repeat(47) + "…");
});

test("deterministic random input never throws or loses non-whitespace raw", () => {
	let state = 713;
	const chars = "#`-*abcXYZ012():\n\r\t\x00\x1b[] ";
	for (let i = 0; i < 150; i++) {
		let text = "";
		for (let j = 0; j < i * 7; j++) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			text += chars[state % chars.length];
		}
		const cards = parseProgress(text);
		if (text.trim()) assert.equal(cards.map((c) => c.raw).join(""), text.replace(/\r\n/g, "\n"));
	}
});

test("sub-headings belong to the item entry and latestCard returns that entry", () => {
	const raw = "# K01 passed: x\n### Verification\n- `npm test` exit 0\n### Notes\n- Assumption: Append-only input.";
	const cards = parseProgress(raw);
	assert.equal(cards.length, 1);
	assert.equal(cards[0].raw, raw);
	assert.deepEqual(cards[0].fields?.checks, [{ cmd: "test", exits: [0], detail: null }]);
	assert.deepEqual(cards[0].fields?.assumed, ["Append-only input."]);
	assert.equal(latestCard(cards)?.id, "K01");
});

test("same or higher headings and item headings at any level still start cards", () => {
	const cards = parseProgress("## K01 passed: x\n### Notes\nplain note\n## Summary\nsummary\n# K02 blocked: y\n#### K02 passed: resolved\n");
	assert.deepEqual(cards.map((c) => c.id), ["K01", null, "K02", "K02"]);
	assert.equal(cards[0].raw, "## K01 passed: x\n### Notes\nplain note\n");
	assert.equal(cards[2].resolvedBy, 3);
	assert.equal(latestCard(cards)?.outcome, "passed");
});

test("backticks in an info string do not open a fence or hide later entries", () => {
	const cards = parseProgress("# A blocked: waiting\n```bash npm test```\n# B passed: other\n# A passed: fixed");
	assert.deepEqual(cards.map((c) => c.id), ["A", "B", "A"]);
	assert.equal(cards[0].resolvedBy, 2);
	assert.equal(latestCard(cards)?.id, "A");
});

test("fences close only with a bare backtick run at least as long as the opener", () => {
	const raw = "# A passed: proof\n````text\n```\n# B blocked: code\n````trailing\n# C blocked: also code\n`````\n# D passed: next";
	const cards = parseProgress(raw);
	assert.deepEqual(cards.map((c) => c.id), ["A", "D"]);
	assert.equal(cards.map((c) => c.raw).join(""), raw);
});

test("a Failed description is not an extra check execution", () => {
	const fields = parseProgress("# X blocked: gate\n- Failing command: `npm run verify` exit 1.\n- Checks: `npm run verify` exit 1; rerun exit 0.")[0].fields;
	assert.equal(fields?.failed?.exit, 1);
	assert.deepEqual(fields?.checks, [{ cmd: "verify", exits: [1, 0], detail: null }]);
});
