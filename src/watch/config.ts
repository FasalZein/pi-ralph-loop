import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { loadRalphBundle } from "../bundle/index.js";
import { validateRequiredFile } from "../bundle/paths.js";
import { isRecord } from "../bundle/schema.js";
import type { Mission, MissionBaseline, MissionPolicy, MissionThinkingLevel, RuleLevel } from "./types.js";

export class MissionConfigError extends Error {
	constructor(readonly field: string, readonly reason: string) {
		super(`Invalid Ralph mission at ${field}: ${reason}`);
		this.name = "MissionConfigError";
	}
}
function fail(field: string, reason: string): never { throw new MissionConfigError(field, reason); }
function at(field: string, key: string | number): string {
	return `${field === "/" ? "" : field}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}
function boundary<T>(field: string, fn: () => T): T {
	try { return fn(); } catch (error) {
		if (error instanceof MissionConfigError) throw error;
		return fail(field, error instanceof Error ? error.message : String(error));
	}
}
function object(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
	if (!isRecord(value)) fail(field, "must be an object");
	for (const key of Object.keys(value)) if (!keys.includes(key)) fail(at(field, key), "unknown field");
	return value;
}
function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) fail(field, "must be a nonblank string");
	return value;
}
function positive(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail(field, "must be a positive safe integer");
	return value;
}
function list<T>(value: unknown, field: string, parse: (entry: unknown, pointer: string) => T): T[] {
	if (!Array.isArray(value)) fail(field, "must be an array");
	return value.map((entry, i) => parse(entry, at(field, i)));
}
function unique(values: readonly string[], field: string): void {
	const seen = new Set<string>();
	values.forEach((value, i) => { if (seen.has(value)) fail(at(field, i), "duplicate value"); seen.add(value); });
}
function optionalText(value: unknown, field: string): string | null { return value === undefined ? null : text(value, field); }
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

function contained(root: string, resolved: string, field: string): void {
	const relative = path.relative(root, resolved);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(field, "path escapes the root");
}
function physicalPath(root: string, relative: string, field: string): string {
	const resolved = path.resolve(root, relative);
	contained(root, resolved, field);
	let ancestor = resolved;
	while (true) {
		try { lstatSync(ancestor); break; } catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return boundary(field, () => { throw error; });
			const parent = path.dirname(ancestor);
			if (parent === ancestor) fail(field, "cannot resolve path ancestor");
			ancestor = parent;
		}
	}
	const real = boundary(field, () => realpathSync(ancestor));
	contained(root, real, field);
	return resolved;
}
function relativePath(value: unknown, field: string): string {
	const input = text(value, field);
	if (input.includes("\0") || input.includes("\\") || path.posix.isAbsolute(input) || /^[a-z]:/i.test(input)) fail(field, "must be a POSIX root-relative path without NUL");
	if (input.split("/").includes("..")) fail(field, "path traversal is not allowed");
	return path.posix.normalize(input).replace(/\/$/, "") || ".";
}
function literalPath(root: string, value: unknown, field: string): string {
	const relative = relativePath(value, field);
	physicalPath(root, relative, field);
	return relative;
}
function globPath(root: string, value: unknown, field: string): string {
	const glob = relativePath(value, field);
	if (glob.startsWith("!")) fail(field, "glob negation is not supported");
	const segments = glob.split("/");
	for (const segment of segments) {
		if (segment.includes("**") && segment !== "**") fail(field, "** must be a whole segment");
		for (let i = 0; i < segment.length; i++) {
			if (/[{}()]/.test(segment[i])) fail(field, "unsupported glob construct");
			if (segment[i] === "]") fail(field, "unmatched character class");
			if (segment[i] === "[") {
				const end = segment.indexOf("]", i + 1);
				if (end < 0 || end === i + 1) fail(field, "unclosed or empty character class");
				if (["!", "^"].includes(segment[i + 1])) fail(field, "character class negation is not supported");
				boundary(field, () => new RegExp(segment.slice(i, end + 1)));
				i = end;
			}
		}
	}
	const wildcard = segments.findIndex(segment => /[*?[]/.test(segment));
	physicalPath(root, (wildcard < 0 ? segments : segments.slice(0, wildcard)).join("/") || ".", field);
	return glob;
}
function regex(value: unknown, field: string): string {
	if (typeof value !== "string") fail(field, "must be a regex source string");
	boundary(field, () => new RegExp(value));
	return value;
}
function argv(root: string, value: unknown, field: string): string[] {
	const args = list(value, field, (entry, pointer) => {
		if (typeof entry !== "string" || entry.includes("\0")) fail(pointer, "must be a string without NUL");
		return entry;
	});
	if (!args.length) fail(field, "must be a nonempty argv array");
	const command = text(args[0], at(field, 0));
	const executableField = at(field, 0);
	const candidates = path.isAbsolute(command) ? [command] : command.includes("/")
		? [path.resolve(root, literalPath(root, command, executableField))]
		: (process.env.PATH ?? "").split(path.delimiter).map(dir => path.resolve(root, dir || ".", command));
	const usable = candidates.some(candidate => {
		try { return statSync(candidate).isFile() && (accessSync(candidate, constants.R_OK | constants.X_OK), true); } catch { return false; }
	});
	if (!usable) fail(executableField, "executable must be a readable executable regular file");
	return args;
}
function scopePolicy(root: string, value: unknown): MissionPolicy["scope"] {
	const field = "/scope";
	const scope = object(value === undefined ? {} : value, field, ["sourceGlobs", "testGlobs", "sourceRegex", "testRegex", "items", "receiptItems", "importerCommand"]);
	const items = list(scope.items === undefined ? [] : scope.items, "/scope/items", (entry, pointer) => {
		const item = object(entry, pointer, ["id", "title", "allowedPaths", "targets"]);
		const allowedPaths = list(item.allowedPaths, at(pointer, "allowedPaths"), (v, p) => literalPath(root, v, p));
		if (!allowedPaths.length) fail(at(pointer, "allowedPaths"), "must not be empty");
		return {
			id: text(item.id, at(pointer, "id")),
			...(item.title === undefined ? {} : { title: text(item.title, at(pointer, "title")) }), allowedPaths,
			targets: list(item.targets === undefined ? [] : item.targets, at(pointer, "targets"), (v, p) => literalPath(root, v, p)),
		};
	});
	const seen = new Set<string>();
	items.forEach((item, i) => { if (seen.has(item.id)) fail(`/scope/items/${i}/id`, "duplicate item ID"); seen.add(item.id); });
	const receiptItems = list(scope.receiptItems === undefined ? [] : scope.receiptItems, "/scope/receiptItems", text);
	unique(receiptItems, "/scope/receiptItems");
	return {
		sourceGlobs: list(scope.sourceGlobs === undefined ? [] : scope.sourceGlobs, "/scope/sourceGlobs", (v, p) => globPath(root, v, p)),
		testGlobs: list(scope.testGlobs === undefined ? [] : scope.testGlobs, "/scope/testGlobs", (v, p) => globPath(root, v, p)),
		sourceRegex: scope.sourceRegex === undefined ? null : regex(scope.sourceRegex, "/scope/sourceRegex"),
		testRegex: scope.testRegex === undefined ? null : regex(scope.testRegex, "/scope/testRegex"), items, receiptItems,
		importerCommand: scope.importerCommand === undefined ? null : argv(root, scope.importerCommand, "/scope/importerCommand"),
	};
}
function protectedPolicy(root: string, value: unknown): MissionPolicy["protected"] {
	const policy = object(value === undefined ? {} : value, "/protected", ["paths", "prefixes"]);
	return {
		paths: list(policy.paths === undefined ? [] : policy.paths, "/protected/paths", (v, p) => literalPath(root, v, p)),
		prefixes: list(policy.prefixes === undefined ? [] : policy.prefixes, "/protected/prefixes", (v, p) => literalPath(root, v, p)),
	};
}
function measurePolicy(root: string, value: unknown): MissionPolicy["measure"] {
	if (value === undefined) return null;
	const measure = object(value, "/measure", ["command", "start"]);
	const command = argv(root, measure.command, "/measure/command");
	if (!isRecord(measure.start)) fail("/measure/start", "must be an object of counts");
	const start: Record<string, number> = {};
	for (const [key, count] of Object.entries(measure.start)) {
		text(key, at("/measure/start", key));
		if (typeof count !== "number" || !Number.isFinite(count) || count < 0) fail(at("/measure/start", key), "must be a finite nonnegative count");
		Object.defineProperty(start, key, { value: count, enumerable: true });
	}
	return { command, start };
}

function namedRows<T extends { readonly name: string }>(value: unknown, field: string, parse: (entry: unknown, pointer: string) => T): T[] {
	const rows = list(value === undefined ? [] : value, field, parse);
	const names = new Set<string>();
	rows.forEach((row, i) => { if (names.has(row.name)) fail(at(at(field, i), "name"), "duplicate name"); names.add(row.name); });
	return rows;
}
function otherAreasPolicy(root: string, value: unknown): MissionPolicy["otherAreas"] {
	return namedRows(value, "/otherAreas", (entry, field) => {
		const area = object(entry, field, ["name", "globs"]);
		const globs = list(area.globs, at(field, "globs"), (v, p) => globPath(root, v, p));
		if (!globs.length) fail(at(field, "globs"), "must not be empty");
		return { name: text(area.name, at(field, "name")), globs };
	});
}
function requiredFile(root: string, relative: string, field: string): string {
	const resolved = physicalPath(root, relative, field);
	if (!relative.startsWith("..")) return boundary(field, () => validateRequiredFile(root, relative));
	// The existing helper rejects every leading '..', including legal ..notes.
	// Keep its leaf checks here only for those names, after precise containment.
	return boundary(field, () => {
		const stat = lstatSync(resolved);
		if (stat.isSymbolicLink() || !stat.isFile()) fail(field, "must be a regular file, not a symlink");
		const real = realpathSync(resolved);
		accessSync(real, constants.R_OK);
		return real;
	});
}
function pointerParts(value: unknown, field: string): { pointer: string; parts: string[] } {
	if (typeof value !== "string" || (value !== "" && !value.startsWith("/")) || /~(?:[^01]|$)/.test(value)) fail(field, "must be a valid JSON Pointer");
	return { pointer: value, parts: value === "" ? [] : value.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~")) };
}
function baselinePolicy(root: string, value: unknown): readonly MissionBaseline[] {
	return namedRows(value, "/baselines", (entry, field): MissionBaseline => {
		const baseline = object(entry, field, ["name", "file", "schema"]);
		const name = text(baseline.name, at(field, "name"));
		const file = literalPath(root, baseline.file, at(field, "file"));
		const schema = object(baseline.schema, at(field, "schema"), ["kind", "pointer"]);
		if (schema.kind !== "counter-map" && schema.kind !== "entry-array") fail(at(at(field, "schema"), "kind"), "must be counter-map or entry-array");
		const { pointer, parts } = pointerParts(schema.pointer, at(at(field, "schema"), "pointer"));
		const absolute = requiredFile(root, file, at(field, "file"));
		let data: unknown = boundary(at(field, "file"), () => JSON.parse(readFileSync(absolute, "utf8")) as unknown);
		for (const part of parts) {
			if (Array.isArray(data)) {
				if (!/^(0|[1-9][0-9]*)$/.test(part) || !Object.hasOwn(data, part)) fail(at(at(field, "schema"), "pointer"), "pointer does not locate baseline data");
				data = data[Number(part)];
			} else if (isRecord(data) && Object.hasOwn(data, part)) data = data[part];
			else fail(at(at(field, "schema"), "pointer"), "pointer does not locate baseline data");
		}
		if (schema.kind === "counter-map") {
			if (!isRecord(data)) fail(at(field, "file"), "baseline data must be a counter map");
			for (const [key, count] of Object.entries(data)) {
				if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) fail(at(at(field, "file"), key), "baseline count must be a nonnegative safe integer");
			}
		} else {
			const entries = list(data, at(field, "file"), text);
			unique(entries, at(field, "file"));
		}
		return { name, file, schema: { kind: schema.kind, pointer } };
	});
}
function thresholdsPolicy(value: unknown): MissionPolicy["thresholds"] {
	if (value === undefined) return null;
	const thresholds = object(value, "/thresholds", ["authority", "largeDiffPaths", "largeDiffLines"]);
	const authority = text(thresholds.authority, "/thresholds/authority");
	if (thresholds.largeDiffPaths === undefined && thresholds.largeDiffLines === undefined) fail("/thresholds", "must specify at least one large-diff threshold");
	return {
		authority,
		...(thresholds.largeDiffPaths === undefined ? {} : { largeDiffPaths: positive(thresholds.largeDiffPaths, "/thresholds/largeDiffPaths") }),
		...(thresholds.largeDiffLines === undefined ? {} : { largeDiffLines: positive(thresholds.largeDiffLines, "/thresholds/largeDiffLines") }),
	};
}
function blockerPolicy(value: unknown): MissionPolicy["blocker"] {
	if (value === undefined) return null;
	const blocker = object(value, "/blocker", ["subjectRegex", "itemGroup"]);
	const subjectRegex = regex(blocker.subjectRegex, "/blocker/subjectRegex");
	const itemGroup = text(blocker.itemGroup, "/blocker/itemGroup");
	// The empty alternative always matches. The engine still exposes every
	// declared group, including groups that did not participate in the match.
	const groups = boundary("/blocker/subjectRegex", () => new RegExp(`(?:${subjectRegex})|`).exec("")?.groups ?? {});
	if (!Object.hasOwn(groups, itemGroup)) fail("/blocker/itemGroup", "must identify a named capture in subjectRegex");
	return { subjectRegex, itemGroup };
}
function testEditPolicy(value: unknown): MissionPolicy["testEdit"] {
	if (value === undefined) return null;
	const testEdit = object(value, "/testEdit", ["mode", "functions"]);
	if (testEdit.mode !== "arguments-only") fail("/testEdit/mode", "must be arguments-only");
	const functions = list(testEdit.functions, "/testEdit/functions", text);
	if (!functions.length) fail("/testEdit/functions", "must not be empty");
	unique(functions, "/testEdit/functions");
	return { mode: "arguments-only", functions };
}
type MissionTask = Pick<Extract<Mission, { readonly task: { readonly kind: "bundle" } }>, "task" | "bundle">
	| Pick<Extract<Mission, { readonly task: { readonly kind: "plain" } }>, "task" | "bundle">;
type TaskInput = { readonly kind: "bundle" } | { readonly kind: "plain"; readonly prompt: string };
function taskInput(value: unknown): TaskInput {
	const task = object(value, "/task", ["kind", "prompt"]);
	if (task.kind === "plain") return { kind: "plain", prompt: text(task.prompt, "/task/prompt") };
	if (task.kind !== "bundle") fail("/task/kind", "must be bundle or plain");
	if (Object.hasOwn(task, "prompt")) fail("/task/prompt", "forbidden for bundle tasks");
	return { kind: "bundle" };
}
function taskPolicy(root: string, input: TaskInput): MissionTask {
	if (input.kind === "plain") return { task: input, bundle: null };
	const bundle = boundary("/task", () => structuredClone(loadRalphBundle(root)));
	const itemKeys = bundle.items.items.map((item, i) => {
		if (item.title !== undefined) text(item.title, "/task");
		return item.id === undefined ? `index:${i}` : text(item.id, "/task");
	});
	if (new Set(itemKeys).size !== itemKeys.length) fail("/task", "duplicate bundle item key");
	const prompt = text(boundary("/task", () => readFileSync(bundle.files[".ralph/prompt.md"], "utf8")), "/task/prompt");
	return { task: { kind: "bundle", prompt }, bundle: { ...bundle, itemKeys } };
}
function checkReferences(task: MissionTask, scope: MissionPolicy["scope"]): void {
	if (task.bundle === null) {
		if (scope.items.length) fail("/scope/items", "requires a bundle task");
		if (scope.receiptItems.length) fail("/scope/receiptItems", "requires a bundle task");
		return;
	}
	const keys = new Set(task.bundle.itemKeys);
	scope.items.forEach((item, i) => { if (!keys.has(item.id)) fail(`/scope/items/${i}/id`, "unknown bundle item key"); });
	scope.receiptItems.forEach((item, i) => { if (!keys.has(item)) fail(`/scope/receiptItems/${i}`, "unknown bundle item key"); });
}

type RuleContext = Omit<MissionPolicy, "rules"> & { readonly bundleTask: boolean };
type RuleDefinition = {
	readonly defaultLevel: RuleLevel | ((context: RuleContext) => RuleLevel);
	readonly requires?: (context: RuleContext) => boolean;
	readonly recordOnly?: boolean;
};
const testDiscovery = (c: RuleContext): boolean => c.scope.testGlobs.length > 0 || c.scope.testRegex !== null;
const sourceDiscovery = (c: RuleContext): boolean => c.scope.sourceGlobs.length > 0 || c.scope.sourceRegex !== null;
const hasBundle = (c: RuleContext): boolean => c.bundleTask;
const baseline = (c: RuleContext, name: string): MissionBaseline | undefined => c.baselines.find(entry => entry.name === name);
// This is package-owned policy input metadata, not worktree evaluation code.
const RULES: Readonly<Record<string, RuleDefinition>> = {
	"suppression-comment": { defaultLevel: "hard" },
	"test-focus": { defaultLevel: c => testDiscovery(c) ? "hard" : "off", requires: testDiscovery },
	"deleted-test": { defaultLevel: c => testDiscovery(c) ? "hard" : "off", requires: testDiscovery },
	"branch-changed": { defaultLevel: "hard" }, "base-not-ancestor": { defaultLevel: "hard" },
	"nonlinear-history": { defaultLevel: "hard" }, "config-changed": { defaultLevel: "hard" },
	"multiple-item-pass": { defaultLevel: c => c.bundleTask ? "hard" : "off", requires: hasBundle },
	"items-beyond-pass-flips": { defaultLevel: c => c.bundleTask ? "warn" : "off", requires: hasBundle },
	"bundle-state-edit": { defaultLevel: c => c.bundleTask ? "warn" : "off", requires: hasBundle },
	"test-edit": { defaultLevel: c => testDiscovery(c) ? "warn" : "off", requires: testDiscovery },
	"heartbeat-stale": { defaultLevel: "warn", recordOnly: true }, "rpc-stall": { defaultLevel: "warn", recordOnly: true },
	"error_count-rise": { defaultLevel: "warn", recordOnly: true }, "bundle_rejection_count-rise": { defaultLevel: "warn", recordOnly: true },
	"shape-new-entry": { defaultLevel: "off", requires: c => baseline(c, "shape") !== undefined },
	"shape-count-rise": { defaultLevel: "off", requires: c => baseline(c, "shape")?.schema.kind === "counter-map" },
	"anti-slop-rise": { defaultLevel: "off", requires: c => baseline(c, "anti-slop")?.schema.kind === "counter-map" },
	"protected-path": { defaultLevel: "off", requires: c => c.protected.paths.length + c.protected.prefixes.length > 0 },
	"pass-without-source": { defaultLevel: "off", requires: c => c.bundleTask && sourceDiscovery(c) },
	"source-without-item-pass": { defaultLevel: "off", requires: c => c.bundleTask && sourceDiscovery(c) },
	"item-order": { defaultLevel: "off", requires: hasBundle },
	"outside-item-and-importers": { defaultLevel: "off", requires: c => c.bundleTask && c.scope.items.length > 0 && c.scope.importerCommand !== null },
	"receipt-item-source-scope": { defaultLevel: "off", requires: c => c.bundleTask && sourceDiscovery(c) && c.scope.receiptItems.length > 0 && c.scope.receiptItems.every(id => c.scope.items.some(item => item.id === id)) },
	"other-area": { defaultLevel: "off", requires: c => c.otherAreas.length > 0 },
	"large-diff": { defaultLevel: "off", requires: c => c.thresholds !== null },
	"debt-measure-rise": { defaultLevel: "off", requires: c => c.measure !== null },
};
function rulesPolicy(value: unknown, context: RuleContext): Readonly<Record<string, RuleLevel>> {
	if (!isRecord(value)) fail("/rules", "must be an object");
	for (const [id, level] of Object.entries(value)) {
		if (!Object.hasOwn(RULES, id)) fail(at("/rules", id), "unknown rule");
		if (level !== "off" && level !== "warn" && level !== "hard") fail(at("/rules", id), "must be off, warn or hard");
	}
	const effective: Record<string, RuleLevel> = {};
	for (const [id, definition] of Object.entries(RULES)) {
		const configured = value[id];
		const level = configured === undefined ? (typeof definition.defaultLevel === "function" ? definition.defaultLevel(context) : definition.defaultLevel) : configured;
		// The earlier map validation narrows every configured value; keep this local
		// guard so construction stays typed without an unchecked cast.
		if (level !== "off" && level !== "warn" && level !== "hard") fail(at("/rules", id), "must be off, warn or hard");
		if (level === "hard" && definition.recordOnly) fail(at("/rules", id), "liveness is record-only and cannot be hard");
		if (level !== "off" && definition.requires && !definition.requires(context)) fail(at("/rules", id), "requires configured policy inputs appropriate for this task");
		effective[id] = level;
	}
	return effective;
}

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;

function gitRead(root: string, field: string, args: string[]): string {
	return boundary(field, () => execFileSync("git", ["--no-optional-locks", ...args], {
		cwd: root, encoding: "utf8", shell: false, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT_BYTES,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim());
}
function commit(root: string, value: unknown, field: string): string {
	const sha = text(value, field).toLowerCase();
	if (!/^[a-f0-9]{40}$/.test(sha)) fail(field, "must be a full 40-hex commit SHA");
	const resolved = gitRead(root, field, ["rev-parse", "--verify", `${sha}^{commit}`]);
	if (resolved !== sha) fail(field, "must identify an exact commit object, not a tag");
	return sha;
}
function thinkingLevel(value: unknown): MissionThinkingLevel {
	const level = text(value, "/run/thinking");
	switch (level) {
		case "off": case "minimal": case "low": case "medium": case "high": case "xhigh": case "max": return level;
		default: return fail("/run/thinking", "unsupported thinking level");
	}
}

export async function loadMission(inputRoot: string): Promise<Mission> {
	const root = boundary("/", () => {
		// native resolves letter case on case-insensitive file systems, like git does.
		const resolved = realpathSync.native(inputRoot);
		if (!statSync(resolved).isDirectory()) fail("/", "root must be a directory");
		accessSync(resolved, constants.R_OK | constants.X_OK);
		return resolved;
	});
	const configPath = boundary("/", () => validateRequiredFile(root, ".ralph/mission.json"));
	const raw = boundary("/", () => JSON.parse(readFileSync(configPath, "utf8")) as unknown);
	const doc = object(raw, "/", ["version", "loop", "task", "run", "git", "scope", "protected", "otherAreas", "baselines", "measure", "rules", "thresholds", "blocker", "testEdit", "host"]);
	if (doc.version !== 1) fail("/version", "must be 1");
	const loop = object(doc.loop === undefined ? {} : doc.loop, "/loop", ["id", "displayName"]);
	const launchTask = taskInput(doc.task);
	const run = object(doc.run, "/run", ["model", "thinking", "maxIterations", "budgetAuthority"]);
	const normalizedRun: MissionPolicy["run"] = {
		model: text(run.model, "/run/model"),
		thinking: thinkingLevel(run.thinking),
		maxIterations: positive(run.maxIterations, "/run/maxIterations"),
		budgetAuthority: text(run.budgetAuthority, "/run/budgetAuthority"),
	};
	const git = object(doc.git, "/git", ["baseCommit", "branch", "parentCommits"]);
	const gitRoot = boundary("/", () => realpathSync.native(gitRead(root, "/git", ["rev-parse", "--show-toplevel"])));
	if (gitRoot !== root) fail("/", "root must be the git worktree top level");
	const baseCommit = commit(root, git.baseCommit, "/git/baseCommit");
	const branch = optionalText(git.branch, "/git/branch");
	if (branch !== null && gitRead(root, "/git/branch", ["check-ref-format", "--branch", branch]) !== branch) fail("/git/branch", "must be a literal branch name, not checkout shorthand");
	const parentCommits = list(git.parentCommits === undefined ? [] : git.parentCommits, "/git/parentCommits", (entry, field) => {
		const parent = object(entry, field, ["sha", "reason"]);
		return { sha: commit(root, parent.sha, at(field, "sha")), reason: text(parent.reason, at(field, "reason")) };
	});
	const parentShas = new Set<string>();
	parentCommits.forEach((parent, i) => {
		if (parentShas.has(parent.sha)) fail(`/git/parentCommits/${i}/sha`, "duplicate SHA");
		parentShas.add(parent.sha);
	});
	const host = object(doc.host, "/host", ["prefer", "herdrWorkspace", "herdrSocket"]);
	const prefer = list(host.prefer, "/host/prefer", (value, field): "tmux" | "herdr" => {
		if (value !== "tmux" && value !== "herdr") fail(field, "must be tmux or herdr"); return value;
	});
	if (!prefer.length) fail("/host/prefer", "must not be empty");
	unique(prefer, "/host/prefer");
	const configuredLoop = {
		id: optionalText(loop.id, "/loop/id"),
		displayName: optionalText(loop.displayName, "/loop/displayName"),
	};
	const inputs: Omit<MissionPolicy, "rules"> = {
		version: 1, loop: { id: configuredLoop.id ?? createHash("sha256").update(root).digest("hex"), displayName: configuredLoop.displayName ?? path.basename(root) },
		run: normalizedRun,
		git: { baseCommit, branch, parentCommits },
		scope: scopePolicy(root, doc.scope),
		protected: protectedPolicy(root, doc.protected), otherAreas: otherAreasPolicy(root, doc.otherAreas), baselines: baselinePolicy(root, doc.baselines), measure: measurePolicy(root, doc.measure), thresholds: thresholdsPolicy(doc.thresholds), blocker: blockerPolicy(doc.blocker), testEdit: testEditPolicy(doc.testEdit),
		host: { prefer, herdrWorkspace: optionalText(host.herdrWorkspace, "/host/herdrWorkspace"), herdrSocket: optionalText(host.herdrSocket, "/host/herdrSocket") },
	};
	const policy: MissionPolicy = { ...inputs, rules: rulesPolicy(doc.rules, { ...inputs, bundleTask: launchTask.kind === "bundle" }) };
	const task = taskPolicy(root, launchTask);
	checkReferences(task, policy.scope);
	// Pin effective policy and item identity, not mutable observations or
	// machine-resolved paths or root-derived display identity. Only explicit
	// loop settings are policy. Baseline contents are separate launch evidence.
	const configHash = hash({ ...policy, loop: configuredLoop, task: task.task, itemKeys: task.bundle?.itemKeys ?? null });
	return freeze({ ...policy, ...task, root, configPath, configHash });
}
