import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/parser.ts";

test("parseArgs parses task and max iterations", () => {
	assert.deepEqual(parseArgs('"do work" --max-iterations=7'), {
		task: "do work",
		maxIterations: 7,
		dryRun: false,
	});

	assert.deepEqual(parseArgs("do work --max-iterations 3"), {
		task: "do work",
		maxIterations: 3,
		dryRun: false,
	});

	assert.deepEqual(parseArgs("do work"), {
		task: "do work",
		maxIterations: 100,
		dryRun: false,
	});

	assert.deepEqual(parseArgs("@.ralph/prompt.md --dry-run"), {
		task: "@.ralph/prompt.md",
		maxIterations: 100,
		dryRun: true,
	});

	assert.equal(parseArgs(""), null);
	assert.equal(parseArgs("--max-iterations=0"), null);
});
