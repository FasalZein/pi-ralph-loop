import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/parser.ts";
import { extractControlPromise } from "../src/loop/control-promise.ts";

test("extractControlPromise accepts a fenced tag with no trailing prose", () => {
	const cases = [
		"```\n<promise>NEXT</promise>\n```",
		"```xml\n<promise>NEXT</promise>\n```",
		"~~~\n<promise>COMPLETE</promise>\n~~~",
		"```text\n<promise>STOP</promise>\n```",
		"```python\n<promise>WAIT</promise>\n```",
	];
	for (const text of cases) {
		assert.equal(
			extractControlPromise({ content: [{ type: "text", text }] }),
			text.includes("NEXT")
				? "NEXT"
				: text.includes("COMPLETE")
					? "COMPLETE"
					: text.includes("STOP")
						? "STOP"
						: "WAIT",
		);
	}
});

test("extractControlPromise still ignores prose after a fenced tag", () => {
	assert.equal(
		extractControlPromise({
			content: [
				{ type: "text", text: "```\n<promise>NEXT</promise>\n```\nDone." },
			],
		}),
		null,
	);
});

test("extractControlPromise ignores a non-fence line that only starts with backticks", () => {
	// "```not a fence because of the space" must not be dropped as a delimiter.
	assert.equal(
		extractControlPromise({
			content: [{ type: "text", text: "``` not a fence\nafter" }],
		}),
		null,
	);
});

test("parseArgs parses task and max iterations", () => {
	assert.deepEqual(parseArgs('"do work" --max-iterations=7'), {
		task: "do work",
		maxIterations: 7,
	});

	assert.deepEqual(parseArgs("do work --max-iterations 3"), {
		task: "do work",
		maxIterations: 3,
	});

	assert.deepEqual(parseArgs("do work"), {
		task: "do work",
		maxIterations: 100,
	});

	assert.equal(parseArgs(""), null);
	assert.equal(parseArgs("--max-iterations=0"), null);
});
