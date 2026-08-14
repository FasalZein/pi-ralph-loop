import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	createExternalGateDigests,
	loadRalphBundle,
	parseBundleItemsJson,
	resolveExternalGateEntrypoint,
	runExternalGate,
	type ExternalGateInput,
} from "../src/bundle/index.ts";
import { validateExternalGateDigests } from "../src/loop/external-gate.ts";
import type { RalphLoopState } from "../src/types.ts";

function workspace(
	script: string,
	externalGate: Record<string, unknown> = {
		entrypoint: "guard.mjs",
		timeout_ms: 500,
	},
): string {
	const root = mkdtempSync(path.join(tmpdir(), "ralph-external-gate-"));
	mkdirSync(path.join(root, ".ralph"), { recursive: true });
	writeFileSync(path.join(root, ".ralph/plan.md"), "plan\n");
	writeFileSync(path.join(root, ".ralph/prompt.md"), "prompt\n");
	writeFileSync(path.join(root, ".ralph/progress.md"), "progress\n");
	writeFileSync(path.join(root, "guard.mjs"), script);
	writeFileSync(
		path.join(root, ".ralph/items.json"),
		JSON.stringify({
			version: 1,
			runtime_contract: { external_gate: externalGate },
			items: [
				{
					category: "test",
					description: "guard lifecycle",
					steps: ["run it"],
					passes: false,
					regression_notes: "",
					owner: "immutable metadata",
				},
			],
		}),
	);
	return root;
}

function input(root: string): ExternalGateInput {
	const digests = createExternalGateDigests(loadRalphBundle(root));
	assert.ok(digests);
	return {
		version: 1,
		hook: "launch",
		workspace_root: root,
		digests,
		heads: { start: null, current: null, accepted: null },
		loop: {
			token: "token-1",
			iteration: 1,
			max_iterations: 6,
			started_at: "2026-08-14T00:00:00.000Z",
			session_id: "session-1",
			stop_reason: null,
		},
	};
}

const passScript = `
let body = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);
await import("node:fs").then(({ writeFileSync }) => writeFileSync("gate-input.json", JSON.stringify({ input, execPath: process.execPath })));
process.stdout.write(JSON.stringify({
  version: 1,
  phase: input.hook,
  mode: "test",
  selected_issue: null,
  selected_title: null,
  start_head: input.heads.start,
  current_head: input.heads.current,
  accepted_head: input.heads.accepted,
  checks: [],
  journal_phase: null,
  linear_action: null,
  exit_code: 0,
  ok: true
}));
`;

test("external_gate schema is strict", () => {
	const valid = JSON.stringify({
		version: 1,
		runtime_contract: {
			external_gate: { entrypoint: "guard.mjs", timeout_ms: 25 },
		},
		items: [
			{
				category: "test",
				description: "x",
				steps: ["x"],
				passes: false,
				regression_notes: "",
			},
		],
	});
	assert.equal(
		parseBundleItemsJson(valid).runtime_contract?.external_gate?.entrypoint,
		"guard.mjs",
	);
	for (const external_gate of [
		{},
		{ entrypoint: "guard.mjs", timeout_ms: 0 },
		{ entrypoint: "guard.mjs", shell: true },
	]) {
		assert.throws(
			() =>
				parseBundleItemsJson(
					valid.replace(
						'{"entrypoint":"guard.mjs","timeout_ms":25}',
						JSON.stringify(external_gate),
					),
				),
			/external_gate/,
		);
	}
});

test("external gate entrypoint stays under the workspace and uses .mjs", () => {
	for (const entrypoint of ["../guard.mjs", "/tmp/guard.mjs", "guard.js"]) {
		const root = workspace(passScript, { entrypoint });
		assert.throws(
			() => resolveExternalGateEntrypoint(loadRalphBundle(root)),
			/escapes the workspace|repository-relative|must end in \.mjs/,
		);
	}
});

test("external gate runs directly with Node and exchanges versioned JSON", () => {
	const root = workspace(passScript);
	assert.equal(runExternalGate(loadRalphBundle(root), input(root)), null);
	const record = JSON.parse(readFileSync(path.join(root, "gate-input.json"), "utf8"));
	assert.equal(record.execPath, process.execPath);
	assert.equal(record.input.version, 1);
	assert.equal(record.input.hook, "launch");
	assert.equal(record.input.loop.token, "token-1");
});

test("external gate fails closed on timeout, signal, malformed output, and non-zero exit", () => {
	for (const [script, pattern, config] of [
		["setTimeout(() => {}, 10_000);", /timed out/, { entrypoint: "guard.mjs", timeout_ms: 20 }],
		["process.kill(process.pid, 'SIGTERM');", /signal SIGTERM/, undefined],
		["process.stdout.write('not json');", /malformed JSON/, undefined],
		["process.exit(7);", /exited with code 7/, undefined],
	] as const) {
		const root = workspace(script, config);
		assert.match(runExternalGate(loadRalphBundle(root), input(root)) ?? "", pattern);
	}
});

test("external gate digests cover the entrypoint and immutable bundle only", () => {
	const root = workspace(passScript);
	const original = createExternalGateDigests(loadRalphBundle(root));
	assert.ok(original);

	writeFileSync(path.join(root, ".ralph/progress.md"), "progress\nappend\n");
	const itemsPath = path.join(root, ".ralph/items.json");
	const items = JSON.parse(readFileSync(itemsPath, "utf8"));
	items.items[0].passes = true;
	items.items[0].regression_notes = "updated";
	writeFileSync(itemsPath, JSON.stringify(items));
	assert.deepEqual(createExternalGateDigests(loadRalphBundle(root)), original);

	const state = {
		external_gate_entrypoint_digest: original.entrypoint,
		immutable_bundle_digest: original.immutable_bundle,
	} as RalphLoopState;
	assert.equal(validateExternalGateDigests(root, state), null);

	writeFileSync(path.join(root, ".ralph/plan.md"), "changed plan\n");
	const planDrift = createExternalGateDigests(loadRalphBundle(root));
	assert.notEqual(planDrift?.immutable_bundle, original.immutable_bundle);
	assert.match(
		validateExternalGateDigests(root, state) ?? "",
		/immutable Ralph bundle digest drift/,
	);

	writeFileSync(path.join(root, ".ralph/plan.md"), "plan\n");
	writeFileSync(path.join(root, "guard.mjs"), `${passScript}\n// drift\n`);
	const entrypointDrift = createExternalGateDigests(loadRalphBundle(root));
	assert.notEqual(entrypointDrift?.entrypoint, original.entrypoint);
	assert.match(
		validateExternalGateDigests(root, state) ?? "",
		/external gate entrypoint digest drift/,
	);
});

test("external gate response v1 requires approved identity fields and phase agreement", () => {
	const narrow = workspace(
		`process.stdout.write(JSON.stringify({ version: 1, ok: true }));`,
	);
	assert.match(
		runExternalGate(loadRalphBundle(narrow), input(narrow)) ?? "",
		/invalid protocol document/,
	);

	const wrongPhase = workspace(passScript.replace("phase: input.hook", 'phase: "stop"'));
	assert.match(
		runExternalGate(loadRalphBundle(wrongPhase), input(wrongPhase)) ?? "",
		/invalid protocol document/,
	);
});
