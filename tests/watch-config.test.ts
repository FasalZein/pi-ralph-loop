import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadMission, MissionConfigError } from "../src/watch/config.js";

function git(root: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture(): { root: string; config: Record<string, any>; save: () => void; close: () => void } {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ralph-mission-")));
	git(root, "init", "-q");
	git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial");
	mkdirSync(path.join(root, ".ralph"));
	const config = {
		version: 1, task: { kind: "plain", prompt: "Do the task." },
		run: { model: "test-model", thinking: "off", maxIterations: 2, budgetAuthority: "Test owner" },
		git: { baseCommit: git(root, "rev-parse", "HEAD") }, rules: {}, host: { prefer: ["tmux"] },
	};
	const save = () => writeFileSync(path.join(root, ".ralph/mission.json"), JSON.stringify(config));
	save();
	return { root, config, save, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("loadMission accepts plain task without bundle files", async () => {
	const f = fixture();
	try {
		const mission = await loadMission(f.root);
		assert.equal(mission.root, f.root);
		assert.deepEqual(mission.task, { kind: "plain", prompt: "Do the task." });
		assert.equal(mission.bundle, null);
		assert.equal(mission.git.branch, null);
		assert.ok(Object.isFrozen(mission));
		assert.ok(Object.isFrozen(mission.run));
		assert.ok(Object.isFrozen(mission.host.prefer));
	} finally { f.close(); }
});

async function invalid(field: string, change: (f: ReturnType<typeof fixture>) => void, reason?: RegExp): Promise<void> {
	const f = fixture();
	try {
		change(f); f.save();
		await assert.rejects(loadMission(f.root), (error: unknown) => {
			assert.ok(error instanceof MissionConfigError);
			assert.equal(error.field, field);
			assert.ok(error.reason.length);
			if (reason) assert.match(error.reason, reason);
			assert.equal(error.message, `Invalid Ralph mission at ${error.field}: ${error.reason}`);
			return true;
		});
	} finally { f.close(); }
}

const requiredFields = ["version", "task", "task/kind", "run", "run/model", "run/thinking", "run/maxIterations", "run/budgetAuthority", "git", "git/baseCommit", "rules", "host", "host/prefer"];
for (const pointer of requiredFields) test(`loadMission rejects missing required launch field /${pointer}`, async () => {
	await invalid(`/${pointer}`, f => {
		const parts = pointer.split("/");
		const parent = parts.length === 1 ? f.config : f.config[parts[0]];
		delete parent[parts.at(-1)!];
	});
});
for (const [pointer, value] of [
	["version", 2], ["task", []], ["run", null], ["run/model", " "], ["run/thinking", "unknown"],
	["run/maxIterations", 1.5], ["run/budgetAuthority", " "], ["host/prefer", []], ["host/prefer", ["shell"]],
	["git/baseCommit", "abcdef"], ["git/baseCommit", "HEAD~1"], ["git/baseCommit", "0".repeat(40)],
	["git/branch", "bad..branch"], ["git/parentCommits", [{ sha: "bad", reason: "test" }]],
	["git/parentCommits", [{ sha: "0".repeat(40), reason: "test" }]],
] as const) test(`loadMission rejects invalid scalar or container /${pointer}: ${JSON.stringify(value)}`, async () => {
	await invalid(pointer === "git/parentCommits" ? "/git/parentCommits/0/sha" : pointer === "host/prefer" && value[0] === "shell" ? "/host/prefer/0" : `/${pointer}`, f => {
		const parts = pointer.split("/");
		const parent = parts.length === 1 ? f.config : f.config[parts[0]];
		parent[parts.at(-1)!] = value;
	});
});
for (const pointer of ["", "loop", "task", "run", "git", "host"]) test(`loadMission rejects unknown field at /${pointer ? `${pointer}/` : ""}extra`, async () => {
	await invalid(`/${pointer ? `${pointer}/` : ""}extra`, f => {
		if (pointer) f.config[pointer] = { ...f.config[pointer], extra: true };
		else f.config.extra = true;
	});
});
test("loadMission rejects empty parent reason", async () => invalid("/git/parentCommits/0/reason", f => {
	f.config.git.parentCommits = [{ sha: f.config.git.baseCommit, reason: " " }];
}));
test("loadMission rejects duplicate normalized parent SHA", async () => invalid("/git/parentCommits/1/sha", f => {
	f.config.git.parentCommits = [
		{ sha: f.config.git.baseCommit, reason: "one" }, { sha: f.config.git.baseCommit.toUpperCase(), reason: "two" },
	];
}));
test("loadMission preserves exact full-SHA approval with reason", async () => {
	const f = fixture();
	try {
		f.config.git.parentCommits = [{ sha: f.config.git.baseCommit.toUpperCase(), reason: " Approved by test owner " }]; f.save();
		assert.deepEqual((await loadMission(f.root)).git.parentCommits, [{ sha: f.config.git.baseCommit, reason: " Approved by test owner " }]);
	} finally { f.close(); }
});
test("loadMission rejects tag-object base", async () => invalid("/git/baseCommit", f => {
	git(f.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "tag", "-am", "tag", "test-tag");
	f.config.git.baseCommit = git(f.root, "rev-parse", "test-tag");
}));

for (const [name, input] of [
	["escaping path", "../escape"], ["absolute policy path", "/etc/hosts"], ["drive-qualified path", "C:/file"],
	["NUL path", "a\0b"], ["backslash path", "a\\b"],
] as const) test(`loadMission rejects ${name}`, async () => invalid("/protected/paths/0", f => { f.config.protected = { paths: [input] }; }));
for (const suffix of ["outside", "outside/future/leaf"]) test(`loadMission rejects symlink parent escape ${suffix}`, async () => {
	const outside = mkdtempSync(path.join(tmpdir(), "ralph-outside-"));
	try { await invalid("/protected/paths/0", f => {
		symlinkSync(outside, path.join(f.root, "outside")); f.config.protected = { paths: [suffix] };
	}); } finally { rmSync(outside, { recursive: true, force: true }); }
});
test("loadMission accepts contained future path and ..notes", async () => {
	const f = fixture();
	try {
		f.config.protected = { paths: ["./future//leaf", "..notes"], prefixes: ["src/"] }; f.save();
		assert.deepEqual((await loadMission(f.root)).protected, { paths: ["future/leaf", "..notes"], prefixes: ["src"] });
	} finally { f.close(); }
});
for (const glob of ["a/[abc", "a/[]", "a/{b,c}", "a/@(b)", "a/b\\", "/a/*", "a/../*", "!a", "a/**b"]) test(`loadMission rejects invalid glob ${glob}`, async () => invalid("/scope/sourceGlobs/0", f => { f.config.scope = { sourceGlobs: [glob] }; }));
test("loadMission accepts supported discovery glob forms", async () => {
	const f = fixture();
	try {
		f.config.scope = { sourceGlobs: ["src/**/*.ts", "lib/a?.[ch]", "[a-z]/*", "..notes/*"], testRegex: "(^|/)test[^/]*\\.ts$" }; f.save();
		assert.deepEqual((await loadMission(f.root)).scope.sourceGlobs, f.config.scope.sourceGlobs);
	} finally { f.close(); }
});
test("loadMission rejects invalid discovery regex", async () => invalid("/scope/sourceRegex", f => { f.config.scope = { sourceRegex: "[" }; }));
for (const [name, value, pointer] of [
	["shell-string command", "node -e 'bad'", "/scope/importerCommand"],
	["empty argv", [], "/scope/importerCommand"],
	["nonstring argv argument", [process.execPath, 2], "/scope/importerCommand/1"],
	["NUL argv", [process.execPath, "a\0b"], "/scope/importerCommand/1"],
	["missing executable", ["ralph-nonexistent-executable"], "/scope/importerCommand/0"],
] as const) test(`loadMission rejects ${name}`, async () => invalid(pointer, f => { f.config.scope = { importerCommand: value }; }));
test("loadMission rejects nonexecutable command", async () => invalid("/scope/importerCommand/0", f => {
	writeFileSync(path.join(f.root, "command"), "not executable"); chmodSync(path.join(f.root, "command"), 0o600);
	f.config.scope = { importerCommand: ["./command"] };
}));
test("loadMission keeps shell punctuation and empty argument literal and never executes commands", async () => {
	const f = fixture();
	try {
		writeFileSync(path.join(f.root, "command"), "#!/bin/sh\ntouch marker\n"); chmodSync(path.join(f.root, "command"), 0o700);
		f.config.scope = { importerCommand: ["./command", "a; b", ""] };
		f.config.measure = { command: [process.execPath, "-e", "require('fs').writeFileSync('marker', '')"], start: { errors: 0 } }; f.save();
		const m = await loadMission(f.root);
		assert.deepEqual(m.scope.importerCommand, ["./command", "a; b", ""]);
		assert.ok(!existsSync(path.join(f.root, "marker")));
	} finally { f.close(); }
});

function bundle(f: ReturnType<typeof fixture>, items?: Record<string, unknown>[]): void {
	f.config.task = { kind: "bundle" };
	for (const name of ["plan", "prompt", "progress"]) writeFileSync(path.join(f.root, `.ralph/${name}.md`), name);
	writeFileSync(path.join(f.root, ".ralph/items.json"), JSON.stringify({ version: 1, extra: { retained: [1] }, items: items ?? [
		{ id: "first", title: "First", category: "feature", description: "Do first", steps: ["verify"], passes: false, regression_notes: "", extra: { retained: [true] } },
		{ category: "feature", description: "Do next", steps: ["verify"], passes: false, regression_notes: "" },
	] }));
}
function complete(f: ReturnType<typeof fixture>): void {
	bundle(f);
	f.config.loop = { id: "test-loop", displayName: "Test loop" };
	f.config.scope = { sourceGlobs: ["src/**/*.ts"], testGlobs: ["tests/**/*.ts"], sourceRegex: "^src/", testRegex: "^tests/",
		items: [{ id: "first", title: "Scoped first", allowedPaths: ["src"], targets: ["src/first.ts"] }, { id: "index:1", allowedPaths: ["src"] }],
		receiptItems: ["first"], importerCommand: [process.execPath, "-e", ""] };
	f.config.protected = { paths: ["policy.json"], prefixes: ["protected"] };
	f.config.otherAreas = [{ name: "assets", globs: ["assets/**"] }];
	writeFileSync(path.join(f.root, "shape.json"), JSON.stringify({ counts: { legacy: 2 } }));
	writeFileSync(path.join(f.root, "slop.json"), JSON.stringify({ legacy: 1 }));
	f.config.baselines = [
		{ name: "shape", file: "shape.json", schema: { kind: "counter-map", pointer: "/counts" } },
		{ name: "anti-slop", file: "slop.json", schema: { kind: "counter-map", pointer: "" } },
	];
	f.config.measure = { command: [process.execPath, "-e", ""], start: { errors: 0, warnings: 1.5 } };
	f.config.thresholds = { authority: "Test owner approves", largeDiffPaths: 5, largeDiffLines: 100 };
	f.config.blocker = { subjectRegex: "^blocked (?<item>[a-z0-9:-]+)$", itemGroup: "item" };
	f.config.testEdit = { mode: "arguments-only", functions: ["assert.equal"] };
	f.config.host = { prefer: ["herdr", "tmux"], herdrWorkspace: "test", herdrSocket: "/external/transport" };
	f.config.git.branch = "future-branch";
	f.config.git.parentCommits = [{ sha: f.config.git.baseCommit, reason: "Approved exact object" }];
}
test("loadMission accepts and deeply freezes a complete bundle mission", async () => {
	const f = fixture();
	try {
		complete(f); f.save(); const m = await loadMission(f.root);
		assert.equal(m.task.kind, "bundle"); assert.equal(m.task.prompt, "prompt");
		assert.ok(m.bundle); assert.deepEqual(m.bundle.itemKeys, ["first", "index:1"]);
		assert.deepEqual(m.bundle.items.extra, { retained: [1] });
		assert.deepEqual(m.bundle.items.items[0].extra, { retained: [true] });
		assert.deepEqual(m.baselines, f.config.baselines);
		assert.deepEqual(m.thresholds, f.config.thresholds);
		assert.deepEqual(m.blocker, f.config.blocker);
		assert.deepEqual(m.testEdit, f.config.testEdit);
		function checkFrozen(value: unknown): void {
			if (value && typeof value === "object") { assert.ok(Object.isFrozen(value)); for (const child of Object.values(value)) checkFrozen(child); }
		}
		checkFrozen(m);
		assert.throws(() => { (m.run as { model: string }).model = "changed"; }, TypeError);
	} finally { f.close(); }
});
for (const [name, mutate, pointer] of [
	["missing bundle file", (f: ReturnType<typeof fixture>) => rmSync(path.join(f.root, ".ralph/progress.md")), "/task"],
	["invalid bundle items", (f: ReturnType<typeof fixture>) => writeFileSync(path.join(f.root, ".ralph/items.json"), "{}"), "/task"],
	["blank bundle prompt", (f: ReturnType<typeof fixture>) => writeFileSync(path.join(f.root, ".ralph/prompt.md"), " "), "/task/prompt"],
	["duplicate item ID", (f: ReturnType<typeof fixture>) => { const data = JSON.parse(readFileSync(path.join(f.root, ".ralph/items.json"), "utf8")); data.items[1].id = "first"; writeFileSync(path.join(f.root, ".ralph/items.json"), JSON.stringify(data)); }, "/task"],
	["derived item ID collision", (f: ReturnType<typeof fixture>) => { const data = JSON.parse(readFileSync(path.join(f.root, ".ralph/items.json"), "utf8")); data.items[0].id = "index:1"; writeFileSync(path.join(f.root, ".ralph/items.json"), JSON.stringify(data)); }, "/task"],
	["duplicate scope ID", (f: ReturnType<typeof fixture>) => { f.config.scope.items[1].id = "first"; }, "/scope/items/1/id"],
	["duplicate receipt ID", (f: ReturnType<typeof fixture>) => { f.config.scope.receiptItems = ["first", "first"]; }, "/scope/receiptItems/1"],
	["unknown scope item", (f: ReturnType<typeof fixture>) => { f.config.scope.items[0].id = "unknown"; }, "/scope/items/0/id"],
	["unknown receipt item", (f: ReturnType<typeof fixture>) => { f.config.scope.receiptItems = ["unknown"]; }, "/scope/receiptItems/0"],
	["duplicate area name", (f: ReturnType<typeof fixture>) => { f.config.otherAreas.push(f.config.otherAreas[0]); }, "/otherAreas/1/name"],
	["duplicate baseline name", (f: ReturnType<typeof fixture>) => { f.config.baselines.push(f.config.baselines[0]); }, "/baselines/2/name"],
] as const) test(`loadMission rejects ${name}`, async () => invalid(pointer, f => { complete(f); mutate(f); }));
for (const [name, value, pointer] of [
	["invalid blocker regex", { subjectRegex: "[", itemGroup: "item" }, "/blocker/subjectRegex"],
	["missing blocker capture", { subjectRegex: "^blocked (item)$", itemGroup: "item" }, "/blocker/itemGroup"],
	["escaped fake blocker capture", { subjectRegex: "\\(\\?<item>literal", itemGroup: "item" }, "/blocker/itemGroup"],
	["capture text in class", { subjectRegex: "[(?<item>)]", itemGroup: "item" }, "/blocker/itemGroup"],
] as const) test(`loadMission rejects ${name}`, async () => invalid(pointer, f => { f.config.blocker = value; }));
for (const [name, value, pointer] of [
	["large diff without authority", { largeDiffPaths: 5 }, "/thresholds/authority"],
	["large diff with blank authority", { authority: " ", largeDiffPaths: 5 }, "/thresholds/authority"],
	["large diff without threshold", { authority: "Test owner" }, "/thresholds"],
	["invalid large-diff threshold", { authority: "Test owner", largeDiffLines: 0 }, "/thresholds/largeDiffLines"],
] as const) test(`loadMission rejects ${name}`, async () => invalid(pointer, f => { f.config.thresholds = value; }));
for (const [name, data, schema, pointer] of [
	["malformed baseline JSON", "{", { kind: "counter-map", pointer: "" }, "/baselines/0/file"],
	["unknown baseline schema", "{}", { kind: "executable", pointer: "" }, "/baselines/0/schema/kind"],
	["invalid baseline pointer", "{}", { kind: "counter-map", pointer: "/bad~2" }, "/baselines/0/schema/pointer"],
	["baseline data shape mismatch", "[]", { kind: "counter-map", pointer: "" }, "/baselines/0/file"],
	["negative counter", '{"a":-1}', { kind: "counter-map", pointer: "" }, "/baselines/0/file/a"],
	["duplicate entry baseline value", '["a","a"]', { kind: "entry-array", pointer: "" }, "/baselines/0/file/1"],
] as const) test(`loadMission rejects ${name}`, async () => invalid(pointer, f => {
	writeFileSync(path.join(f.root, "debt.json"), data);
	f.config.baselines = [{ name: "test", file: "debt.json", schema }];
}));
test("loadMission accepts entry-array baseline with escaped pointer", async () => {
	const f = fixture();
	try {
		writeFileSync(path.join(f.root, "debt.json"), '{"a/b":{"~c":["one","two"]}}');
		f.config.baselines = [{ name: "entries", file: "debt.json", schema: { kind: "entry-array", pointer: "/a~1b/~0c" } }]; f.save();
		assert.equal((await loadMission(f.root)).baselines[0].schema.pointer, "/a~1b/~0c");
	} finally { f.close(); }
});

const genericDefaults = {
	"suppression-comment": "hard", "test-focus": "off", "deleted-test": "off", "branch-changed": "hard", "base-not-ancestor": "hard",
	"nonlinear-history": "hard", "config-changed": "hard", "multiple-item-pass": "off", "items-beyond-pass-flips": "off", "bundle-state-edit": "off",
	"test-edit": "off", "heartbeat-stale": "warn", "rpc-stall": "warn", "error_count-rise": "warn", "bundle_rejection_count-rise": "warn",
	"shape-new-entry": "off", "shape-count-rise": "off", "anti-slop-rise": "off", "protected-path": "off", "pass-without-source": "off",
	"source-without-item-pass": "off", "item-order": "off", "outside-item-and-importers": "off", "receipt-item-source-scope": "off",
	"other-area": "off", "large-diff": "off", "debt-measure-rise": "off",
};
test("loadMission names only generic defaults and leaves project policy absent", async () => {
	const f = fixture();
	try {
		const m = await loadMission(f.root);
		assert.deepEqual(m.rules, genericDefaults);
		assert.deepEqual(m.scope, { sourceGlobs: [], testGlobs: [], sourceRegex: null, testRegex: null, items: [], receiptItems: [], importerCommand: null });
		assert.deepEqual(m.protected, { paths: [], prefixes: [] }); assert.deepEqual(m.baselines, []); assert.deepEqual(m.otherAreas, []);
		assert.equal(m.measure, null); assert.equal(m.thresholds, null); assert.equal(m.blocker, null); assert.equal(m.testEdit, null);
		assert.equal(m.git.branch, null); assert.deepEqual(m.git.parentCommits, []);
		assert.equal(m.run.model, "test-model"); assert.equal(m.run.maxIterations, 2);
		assert.equal(m.loop.displayName, path.basename(f.root)); assert.equal(m.loop.id, createHash("sha256").update(f.root).digest("hex"));
	} finally { f.close(); }
});
for (const id of ["unknown", "concurrent-edit-retry", "importer-check-unavailable", "measure-unavailable", "stop-command", "stop-command-failed", "observation-failed", "approved-parent-commit", "loop-ended", "__proto__"]) test(`loadMission rejects unknown rule ${id}`, async () => invalid(`/rules/${id}`, f => { f.config.rules = { [id]: "off" }; }));
const conditionalRules = ["test-focus", "deleted-test", "test-edit", "shape-new-entry", "shape-count-rise", "anti-slop-rise", "protected-path", "pass-without-source", "source-without-item-pass", "item-order", "outside-item-and-importers", "receipt-item-source-scope", "other-area", "large-diff", "debt-measure-rise"];
for (const id of conditionalRules) test(`loadMission rejects enabled rule missing prerequisite ${id}`, async () => invalid(`/rules/${id}`, f => { f.config.rules = { [id]: "warn" }; }, /requires/));
for (const id of ["heartbeat-stale", "rpc-stall", "error_count-rise", "bundle_rejection_count-rise"]) test(`loadMission rejects hard liveness setting ${id}`, async () => invalid(`/rules/${id}`, f => { f.config.rules = { [id]: "hard" }; }, /record-only/));
for (const id of ["multiple-item-pass", "items-beyond-pass-flips", "bundle-state-edit"]) test(`loadMission rejects plain task enabled bundle rule ${id}`, async () => invalid(`/rules/${id}`, f => { f.config.rules = { [id]: "warn" }; }, /requires/));
test("loadMission accepts all enabled policy rules with prerequisites", async () => {
	const f = fixture();
	try {
		complete(f); f.config.rules = Object.fromEntries(conditionalRules.map(id => [id, "hard"])); f.save();
		const m = await loadMission(f.root);
		for (const id of conditionalRules) assert.equal(m.rules[id], "hard");
		assert.equal(m.rules["multiple-item-pass"], "hard"); assert.equal(m.rules["items-beyond-pass-flips"], "warn");
	} finally { f.close(); }
});
test("loadMission permits explicit off without prerequisites", async () => {
	const f = fixture();
	try { f.config.rules = Object.fromEntries(conditionalRules.map(id => [id, "off"])); f.save(); assert.deepEqual((await loadMission(f.root)).rules, genericDefaults); }
	finally { f.close(); }
});
test("loadMission requires counter-map for shape-count-rise and anti-slop-rise", async () => {
	for (const id of ["shape-count-rise", "anti-slop-rise"]) await invalid(`/rules/${id}`, f => {
		writeFileSync(path.join(f.root, "debt.json"), '["entry"]');
		f.config.baselines = [{ name: id === "shape-count-rise" ? "shape" : "anti-slop", file: "debt.json", schema: { kind: "entry-array", pointer: "" } }];
		f.config.rules = { [id]: "warn" };
	}, /requires/);
});
test("loadMission requires applicable receipt item scopes", async () => invalid("/rules/receipt-item-source-scope", f => {
	complete(f); f.config.scope.items = [f.config.scope.items[1]]; f.config.rules = { "receipt-item-source-scope": "warn" };
}, /requires/));

function set(config: Record<string, any>, pointer: string, value: unknown): void {
	const parts = pointer.split("/").filter(Boolean);
	let target = config;
	for (const part of parts.slice(0, -1)) target = target[part];
	target[parts.at(-1)!] = value;
}
for (const pointer of ["/scope", "/scope/items/0", "/protected", "/otherAreas/0", "/baselines/0", "/baselines/0/schema", "/measure", "/thresholds", "/blocker", "/testEdit", "/git/parentCommits/0"]) test(`loadMission rejects unknown field at ${pointer}/extra`, async () => invalid(`${pointer}/extra`, f => {
	complete(f); set(f.config, `${pointer}/extra`, true);
}));
for (const [pointer, value, errorPointer] of [
	["/loop", null], ["/loop/id", 1], ["/loop/displayName", ""], ["/task/kind", "other"], ["/task/prompt", "forbidden"],
	["/run/thinking", 2], ["/run/maxIterations", Number.MAX_SAFE_INTEGER + 1], ["/run/maxIterations", 0], ["/run/maxIterations", -1],
	["/git/branch", 2], ["/git/parentCommits", {}], ["/git/parentCommits/0", null],
	["/scope", []], ["/scope/sourceGlobs", "src/*"], ["/scope/testGlobs", [2], "/scope/testGlobs/0"], ["/scope/sourceRegex", null],
	["/scope/items", {}], ["/scope/items/0", []], ["/scope/items/0/id", " "], ["/scope/items/0/title", " "],
	["/scope/items/0/allowedPaths", []], ["/scope/items/0/targets", 1], ["/scope/receiptItems", [2], "/scope/receiptItems/0"],
	["/protected", null], ["/protected/paths", {}], ["/protected/prefixes", [false], "/protected/prefixes/0"],
	["/otherAreas", {}], ["/otherAreas/0", []], ["/otherAreas/0/name", " "], ["/otherAreas/0/globs", []],
	["/baselines", {}], ["/baselines/0", null], ["/baselines/0/name", ""], ["/baselines/0/file", 1], ["/baselines/0/schema", []],
	["/baselines/0/schema/pointer", "missing-slash"], ["/baselines/0/schema/pointer", "/missing"],
	["/measure", null], ["/measure/command", []], ["/measure/start", []], ["/measure/start/errors", -1], ["/measure/start/errors", Infinity],
	["/rules", []], ["/rules/suppression-comment", "info"],
	["/thresholds", []], ["/thresholds/largeDiffPaths", 1.5], ["/blocker", null], ["/blocker/itemGroup", " "],
	["/testEdit", {}, "/testEdit/mode"], ["/testEdit/mode", "all"], ["/testEdit/functions", []], ["/testEdit/functions", ["same", "same"], "/testEdit/functions/1"],
	["/host", []], ["/host/prefer", "tmux"], ["/host/prefer", ["tmux", "tmux"], "/host/prefer/1"],
	["/host/herdrWorkspace", 1], ["/host/herdrSocket", " "],
] as const) test(`loadMission rejects invalid scalar or container at ${pointer}: ${JSON.stringify(value)}`, async () => invalid(errorPointer ?? pointer, f => { complete(f); set(f.config, pointer, value); }));

for (const [name, raw] of [["malformed JSON", "{"], ["non-object document", "[]"]] as const) test(`loadMission rejects ${name}`, async () => {
	const f = fixture();
	try {
		writeFileSync(path.join(f.root, ".ralph/mission.json"), raw);
		await assert.rejects(loadMission(f.root), (e: unknown) => { assert.ok(e instanceof MissionConfigError); assert.equal(e.field, "/"); return true; });
	} finally { f.close(); }
});
for (const name of ["missing root", "non-directory root", "missing mission", "symlink mission", "unreadable required file"] as const) test(`loadMission rejects ${name}`, async () => {
	const f = fixture();
	try {
		let root = f.root;
		const configPath = path.join(root, ".ralph/mission.json");
		if (name === "missing root") root = path.join(root, "missing");
		if (name === "non-directory root") root = configPath;
		if (name === "missing mission") rmSync(configPath);
		if (name === "symlink mission") { rmSync(configPath); writeFileSync(path.join(root, "mission.json"), "{}"); symlinkSync(path.join(root, "mission.json"), configPath); }
		if (name === "unreadable required file") chmodSync(configPath, 0o000);
		await assert.rejects(loadMission(root), (e: unknown) => { assert.ok(e instanceof MissionConfigError); assert.equal(e.field, "/"); return true; });
	} finally { f.close(); }
});
test("loadMission canonicalizes symlinked root", async () => {
	const f = fixture(); const linkParent = mkdtempSync(path.join(tmpdir(), "ralph-link-"));
	try {
		const link = path.join(linkParent, "root"); symlinkSync(f.root, link);
		const direct = await loadMission(f.root); const linked = await loadMission(link);
		assert.equal(linked.root, f.root); assert.equal(linked.configHash, direct.configHash);
		assert.equal(linked.configPath, path.join(f.root, ".ralph/mission.json"));
	} finally { f.close(); rmSync(linkParent, { recursive: true, force: true }); }
});
test("loadMission accepts case-variant worktree root on case-insensitive filesystems", async (t) => {
	const f = fixture();
	try {
		const variant = path.join(path.dirname(f.root), path.basename(f.root).toUpperCase());
		if (variant === f.root || !existsSync(variant)) { t.skip("file system is case-sensitive"); return; }
		const mission = await loadMission(variant);
		assert.equal(mission.root, f.root);
	} finally { f.close(); }
});
test("loadMission rejects mission parent symlink escape", async () => {
	const f = fixture(); const outside = mkdtempSync(path.join(tmpdir(), "ralph-config-outside-"));
	try {
		rmSync(path.join(f.root, ".ralph"), { recursive: true });
		writeFileSync(path.join(outside, "mission.json"), JSON.stringify(f.config)); symlinkSync(outside, path.join(f.root, ".ralph"));
		await assert.rejects(loadMission(f.root), (e: unknown) => { assert.ok(e instanceof MissionConfigError); assert.equal(e.field, "/"); return true; });
	} finally { f.close(); rmSync(outside, { recursive: true, force: true }); }
});
test("loadMission rejects unreadable baseline", async () => invalid("/baselines/0/file", f => {
	writeFileSync(path.join(f.root, "debt.json"), "{}"); chmodSync(path.join(f.root, "debt.json"), 0o000);
	f.config.baselines = [{ name: "test", file: "debt.json", schema: { kind: "counter-map", pointer: "" } }];
}));
test("loadMission rejects plain task bundle-only scope data", async () => {
	await invalid("/scope/items", f => { f.config.scope = { items: [{ id: "test", allowedPaths: ["src"] }] }; });
	await invalid("/scope/receiptItems", f => { f.config.scope = { receiptItems: ["test"] }; });
});
test("loadMission rejects symlink discovery prefix", async () => {
	const outside = mkdtempSync(path.join(tmpdir(), "ralph-glob-outside-"));
	try { await invalid("/scope/testGlobs/0", f => { symlinkSync(outside, path.join(f.root, "outside")); f.config.scope = { testGlobs: ["outside/**/*.ts"] }; }); }
	finally { rmSync(outside, { recursive: true, force: true }); }
});

function reverseKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reverseKeys);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
	return value;
}
test("loadMission hash ignores JSON formatting and recursive key order", async () => {
	const f = fixture();
	try {
		complete(f); f.config.measure.start.second = 3; f.save(); const before = await loadMission(f.root);
		writeFileSync(path.join(f.root, ".ralph/mission.json"), JSON.stringify(reverseKeys(f.config), null, 4));
		assert.equal((await loadMission(f.root)).configHash, before.configHash);
	} finally { f.close(); }
});
test("loadMission hash equates omitted and explicit generic defaults", async () => {
	const f = fixture();
	try {
		const before = await loadMission(f.root);
		f.config.rules = { ...genericDefaults };
		f.config.scope = { sourceGlobs: [], testGlobs: [], items: [], receiptItems: [] };
		f.config.protected = { paths: [], prefixes: [] }; f.config.otherAreas = []; f.config.baselines = []; f.config.git.parentCommits = [];
		f.save();
		assert.equal((await loadMission(f.root)).configHash, before.configHash);
	} finally { f.close(); }
});
const policyChanges: readonly [string, unknown][] = [
	["/loop/id", "another-loop"], ["/loop/displayName", "Another loop"],
	["/run/model", "other-model"], ["/run/thinking", "high"], ["/run/maxIterations", 3], ["/run/budgetAuthority", "Another owner"],
	["/git/branch", "another-branch"], ["/git/parentCommits", []], ["/git/parentCommits/0/reason", "Different approval"],
	["/scope/sourceGlobs", ["lib/**"]], ["/scope/testGlobs", ["spec/**"]], ["/scope/sourceRegex", "^lib/"], ["/scope/testRegex", "^spec/"],
	["/scope/items/0/title", "Another title"], ["/scope/items/0/allowedPaths", ["lib"]], ["/scope/items/0/targets", ["lib/first.ts"]],
	["/scope/items", [{ id: "index:1", allowedPaths: ["src"] }, { id: "first", title: "Scoped first", allowedPaths: ["src"], targets: ["src/first.ts"] }]],
	["/scope/receiptItems", ["index:1"]], ["/scope/importerCommand", [process.execPath, "", "-e"]],
	["/protected/paths", ["other-policy.json"]], ["/protected/prefixes", ["private"]],
	["/otherAreas/0/name", "media"], ["/otherAreas/0/globs", ["media/**"]],
	["/baselines/0/name", "shape-other"], ["/baselines/0/file", "other-shape.json"], ["/baselines/0/schema/pointer", "/otherCounts"],
	["/baselines", [{ name: "anti-slop", file: "slop.json", schema: { kind: "counter-map", pointer: "" } }, { name: "shape", file: "shape.json", schema: { kind: "counter-map", pointer: "/counts" } }]],
	["/measure/command", [process.execPath, "", "-e"]], ["/measure/start/errors", 1],
	["/rules/suppression-comment", "warn"], ["/thresholds/authority", "Another approver"], ["/thresholds/largeDiffPaths", 6], ["/thresholds/largeDiffLines", 101],
	["/blocker/subjectRegex", "^stalled (?<item>[a-z]+)$"], ["/blocker", { subjectRegex: "(?<key>.*)", itemGroup: "key" }],
	["/testEdit/functions", ["assert.ok"]], ["/host/prefer", ["tmux", "herdr"]], ["/host/herdrWorkspace", "other"], ["/host/herdrSocket", "/other/socket"],
];
for (const [pointer, value] of policyChanges) test(`loadMission hash changes for policy leaf ${pointer}`, async () => {
	const f = fixture();
	try {
		complete(f);
		writeFileSync(path.join(f.root, "shape.json"), '{"counts":{"a":1},"otherCounts":{"b":2}}');
		writeFileSync(path.join(f.root, "other-shape.json"), '{"counts":{"a":1}}');
		f.save(); const before = (await loadMission(f.root)).configHash;
		set(f.config, pointer, value); f.save(); assert.notEqual((await loadMission(f.root)).configHash, before);
	} finally { f.close(); }
});
test("loadMission hash changes for launch prompts, task kind, base and effective item keys", async () => {
	const f = fixture();
	try {
		complete(f); f.save(); const initial = (await loadMission(f.root)).configHash;
		writeFileSync(path.join(f.root, ".ralph/prompt.md"), "new prompt"); assert.notEqual((await loadMission(f.root)).configHash, initial);
		writeFileSync(path.join(f.root, ".ralph/prompt.md"), "prompt");
		const itemsFile = path.join(f.root, ".ralph/items.json"); const original = readFileSync(itemsFile, "utf8"); const data = JSON.parse(original);
		data.items[1].id = "second"; writeFileSync(itemsFile, JSON.stringify(data)); f.config.scope.items[1].id = "second"; f.save();
		assert.notEqual((await loadMission(f.root)).configHash, initial);
		writeFileSync(itemsFile, original); f.config.scope.items[1].id = "index:1";
		git(f.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "next");
		f.config.git.baseCommit = git(f.root, "rev-parse", "HEAD"); f.save(); assert.notEqual((await loadMission(f.root)).configHash, initial);
		f.config.task = { kind: "plain", prompt: "prompt" }; f.config.scope.items = []; f.config.scope.receiptItems = []; f.save();
		const plain = (await loadMission(f.root)).configHash; assert.notEqual(plain, initial);
		f.config.task.prompt = "changed plain prompt"; f.save(); assert.notEqual((await loadMission(f.root)).configHash, plain);
	} finally { f.close(); }
});
test("loadMission hash excludes bundle progress, descriptions, baseline contents and current HEAD", async () => {
	const f = fixture();
	try {
		complete(f); f.save(); const before = (await loadMission(f.root)).configHash;
		writeFileSync(path.join(f.root, ".ralph/progress.md"), "ordinary progress");
		const file = path.join(f.root, ".ralph/items.json"); const data = JSON.parse(readFileSync(file, "utf8"));
		data.items[0].passes = true; data.items[0].description = "display only"; data.items[0].steps = ["changed display step"]; writeFileSync(file, JSON.stringify(data));
		writeFileSync(path.join(f.root, "shape.json"), '{"counts":{"new":100}}');
		git(f.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "ordinary work");
		assert.equal((await loadMission(f.root)).configHash, before);
	} finally { f.close(); }
});
test("loadMission hash excludes machine path resolution", async () => {
	const f = fixture(); const g = fixture(); const originalPath = process.env.PATH;
	try {
		complete(f); f.config.scope.importerCommand = ["mission-tool", "a; b"];
		for (const dir of ["bin-a", "bin-b"]) { mkdirSync(path.join(f.root, dir)); symlinkSync(process.execPath, path.join(f.root, dir, "mission-tool")); }
		process.env.PATH = `${path.join(f.root, "bin-a")}${path.delimiter}${originalPath}`;
		f.save(); const before = (await loadMission(f.root)).configHash;
		process.env.PATH = `${path.join(f.root, "bin-b")}${path.delimiter}${originalPath}`;
		assert.equal((await loadMission(f.root)).configHash, before);
		git(g.root, "fetch", "-q", f.root, f.config.git.baseCommit);
		for (const file of [".ralph", "shape.json", "slop.json"]) cpSync(path.join(f.root, file), path.join(g.root, file), { recursive: true });
		const copied = await loadMission(g.root);
		assert.notEqual(copied.root, f.root); assert.equal(copied.configHash, before);
	} finally { process.env.PATH = originalPath; f.close(); g.close(); }
});

test("loadMission accepts contained symlink parents for baseline data and ..notes baseline names", async () => {
	const f = fixture();
	try {
		mkdirSync(path.join(f.root, "data")); writeFileSync(path.join(f.root, "data/debt.json"), "{}");
		symlinkSync(path.join(f.root, "data"), path.join(f.root, "data-link")); writeFileSync(path.join(f.root, "..notes.json"), "{}");
		f.config.baselines = [
			{ name: "linked", file: "data-link/debt.json", schema: { kind: "counter-map", pointer: "" } },
			{ name: "notes", file: "..notes.json", schema: { kind: "counter-map", pointer: "" } },
		]; f.save(); assert.deepEqual((await loadMission(f.root)).baselines, f.config.baselines);
	} finally { f.close(); }
});
test("loadMission rejects branch checkout shorthand", async () => invalid("/git/branch", f => {
	git(f.root, "checkout", "-qb", "second"); git(f.root, "checkout", "-q", "-"); f.config.git.branch = "@{-1}";
}));
test("loadMission accepts literal glob punctuation inside character classes", async () => {
	const f = fixture();
	try { f.config.scope = { sourceGlobs: ["src/[{}()].ts", "src/[a!].ts"] }; f.save(); assert.deepEqual((await loadMission(f.root)).scope.sourceGlobs, f.config.scope.sourceGlobs); }
	finally { f.close(); }
});
for (const glob of ["src/[!a].ts", "src/[^a].ts"]) test(`loadMission rejects negated character class ${glob}`, async () => invalid("/scope/sourceGlobs/0", f => { f.config.scope = { sourceGlobs: [glob] }; }));

test("loadMission validates launch data before reading bundle files", async () => invalid("/run/model", f => {
	f.config.task = { kind: "bundle" }; delete f.config.run.model;
}));
test("loadMission validates nested policy fields before reading bundle files", async () => invalid("/scope/extra", f => {
	f.config.task = { kind: "bundle" }; f.config.scope = { extra: true };
}));

test("loadMission rejects nonfinite measurement count from JSON numeric overflow", async () => {
	const f = fixture();
	try {
		f.config.measure = { command: [process.execPath], start: { errors: 0 } }; f.save();
		const file = path.join(f.root, ".ralph/mission.json"); writeFileSync(file, readFileSync(file, "utf8").replace('"errors":0', '"errors":1e400'));
		await assert.rejects(loadMission(f.root), (e: unknown) => { assert.ok(e instanceof MissionConfigError); assert.equal(e.field, "/measure/start/errors"); assert.match(e.reason, /finite/); return true; });
	} finally { f.close(); }
});
test("loadMission escapes JSON Pointer components in errors", async () => {
	await invalid("/measure/start/a~1b~0c", f => { f.config.measure = { command: [process.execPath], start: { "a/b~c": -1 } }; });
	await invalid("/rules/a~1b~0c", f => { f.config.rules = { "a/b~c": "warn" }; });
});
test("loadMission hash changes for baseline schema kind", async () => {
	const f = fixture();
	try {
		writeFileSync(path.join(f.root, "debt.json"), "{}");
		f.config.baselines = [{ name: "test", file: "debt.json", schema: { kind: "counter-map", pointer: "" } }]; f.save();
		const before = (await loadMission(f.root)).configHash;
		writeFileSync(path.join(f.root, "debt.json"), "[]"); f.config.baselines[0].schema.kind = "entry-array"; f.save();
		assert.notEqual((await loadMission(f.root)).configHash, before);
	} finally { f.close(); }
});
test("loadMission accepts all installed thinking levels", async () => {
	const f = fixture();
	try {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) { f.config.run.thinking = level; f.save(); assert.equal((await loadMission(f.root)).run.thinking, level); }
	} finally { f.close(); }
});
test("loadMission rejects root outside a git worktree", async () => invalid("/git", f => { rmSync(path.join(f.root, ".git"), { recursive: true }); }));
test("loadMission applies discovery defaults for regex-only test discovery", async () => {
	const f = fixture();
	try {
		f.config.scope = { testRegex: "test" }; f.save(); const m = await loadMission(f.root);
		assert.equal(m.rules["test-focus"], "hard"); assert.equal(m.rules["deleted-test"], "hard"); assert.equal(m.rules["test-edit"], "warn");
	} finally { f.close(); }
});
test("loadMission rejects missing baseline and symlink baseline leaf", async () => {
	await invalid("/baselines/0/file", f => { f.config.baselines = [{ name: "test", file: "missing.json", schema: { kind: "counter-map", pointer: "" } }]; });
	await invalid("/baselines/0/file", f => {
		writeFileSync(path.join(f.root, "debt.json"), "{}"); symlinkSync(path.join(f.root, "debt.json"), path.join(f.root, "link.json"));
		f.config.baselines = [{ name: "test", file: "link.json", schema: { kind: "counter-map", pointer: "" } }];
	});
});

test("loadMission rejects a root below the git worktree top level", async () => {
	const f = fixture();
	try {
		const subdirectory = path.join(f.root, "subdirectory");
		mkdirSync(path.join(subdirectory, ".ralph"), { recursive: true });
		cpSync(path.join(f.root, ".ralph/mission.json"), path.join(subdirectory, ".ralph/mission.json"));
		await assert.rejects(loadMission(subdirectory), (error: unknown) => {
			assert.ok(error instanceof MissionConfigError);
			assert.equal(error.field, "/");
			assert.equal(error.reason, "root must be the git worktree top level");
			return true;
		});
	} finally { f.close(); }
});
test("loadMission hash excludes root-derived identity when loop settings are absent", async () => {
	const f = fixture(); const g = fixture();
	try {
		git(g.root, "fetch", "-q", f.root, f.config.git.baseCommit);
		cpSync(path.join(f.root, ".ralph/mission.json"), path.join(g.root, ".ralph/mission.json"));
		const first = await loadMission(f.root); const second = await loadMission(g.root);
		assert.notEqual(first.loop.id, second.loop.id);
		assert.notEqual(first.loop.displayName, second.loop.displayName);
		assert.equal(first.configHash, second.configHash);
	} finally { f.close(); g.close(); }
});

for (const source of ["^never-empty (?<item>[a-z]+)$", "(?<=prefix)(?<item>suffix)", "(?<\\u0069tem>value)"]) test(`loadMission validates declared blocker group with the regex engine: ${source}`, async () => {
	const f = fixture();
	try {
		f.config.blocker = { subjectRegex: source, itemGroup: "item" }; f.save();
		assert.deepEqual((await loadMission(f.root)).blocker, f.config.blocker);
	} finally { f.close(); }
});
