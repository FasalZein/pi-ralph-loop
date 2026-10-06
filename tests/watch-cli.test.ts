import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/watch/cli.ts";

test("CLI parses modes timeout and usage errors", () => {
	assert.deepEqual(parse(["status", "r"]), { kind: "request", request: { kind: "status", root: "r" } });
	assert.deepEqual(parse([]), { kind: "help" });
	assert.deepEqual(parse(["launch", "r"]), { kind: "request", request: { kind: "launch", root: "r", mode: "fresh" } });
	for (const mode of ["fresh", "relaunch", "resume"] as const) assert.deepEqual(parse(["launch", "r", `--${mode}`]), { kind: "request", request: { kind: "launch", root: "r", mode } });
	assert.deepEqual(parse(["stop", "r"]), { kind: "request", request: { kind: "stop", root: "r", timeoutMs: null } });
	assert.deepEqual(parse(["stop", "r", "--timeout", "2.5"]), { kind: "request", request: { kind: "stop", root: "r", timeoutMs: 2500 } });
	assert.deepEqual(parse(["watch", "r"]), { kind: "watch", root: "r" });
	assert.deepEqual(parse(["_driver", "/abs/manifest.json"]), { kind: "driver", manifest: "/abs/manifest.json" });
	assert.deepEqual(parse(["_enforcer", "/abs/manifest.json"]), { kind: "enforcer", manifest: "/abs/manifest.json" });
	for (const argv of [["launch"], ["launch", "r", "--fresh", "--resume"], ["launch", "r", "--model", "x"], ["stop", "r", "--timeout"], ["stop", "r", "--timeout", "0"], ["stop", "r", "--timeout", "-1"], ["stop", "r", "--timeout", "abc"], ["status", "r", "extra"], ["status"], ["status", "r", "--timeout", "2"], ["watch"], ["watch", "r", "extra"], ["watch", "-h"], ["_driver", "relative"], ["_enforcer", "relative"], ["_enforcer", "/abs", "extra"], ["--help", "extra"]]) assert.equal(parse(argv), null, argv.join(" "));
});
