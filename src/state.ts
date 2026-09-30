import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RalphLoopState } from "./types.js";

/** Relative path to the state file from project root */
const STATE_FILE = join(".ralph", "loop.md");

/**
 * Coercion kinds for persisted state fields. Each kind defines how a parsed
 * frontmatter value is normalized back into a typed field (and its default
 * when the value is missing or the wrong type).
 */
type FieldKind = "bool" | "int" | "intNull" | "string" | "stringNull" | "token";

/**
 * One authority per kind: `accepts` is the raw-type check used by the
 * detailed reader, `coerce` the legacy normalization used by readState.
 * Strict essential-field checks live in ESSENTIAL_FIELDS, not here.
 */
const FIELD_KINDS: Record<
	FieldKind,
	{ accepts: (value: unknown) => boolean; coerce: (value: unknown) => unknown }
> = {
	bool: {
		accepts: (value) => typeof value === "boolean",
		coerce: (value) => value === true,
	},
	int: {
		accepts: (value) => typeof value === "number",
		coerce: (value) => (typeof value === "number" ? value : 0),
	},
	intNull: {
		accepts: (value) => value === null || typeof value === "number",
		coerce: (value) => (typeof value === "number" ? value : null),
	},
	string: {
		accepts: (value) => typeof value === "string",
		coerce: (value) => (typeof value === "string" ? value : ""),
	},
	stringNull: {
		accepts: (value) => value === null || typeof value === "string",
		coerce: (value) => (typeof value === "string" ? value : null),
	},
	token: {
		// Raw capture keeps empty strings; the legacy reader replaces them.
		accepts: (value) => typeof value === "string",
		coerce: (value) =>
			typeof value === "string" && value.length > 0 ? value : randomUUID(),
	},
};

/**
 * Ordered descriptor for every persisted field. This single list drives both
 * serialization (writeState) and parsing (readState), so a new field is one
 * entry here rather than three parallel edits. `satisfies` constrains keys to
 * the RalphLoopState interface; the assertion below proves the descriptor
 * covers every field.
 */
const STATE_SCHEMA = [
	["running", "bool"],
	["iteration", "int"],
	["max_iterations", "int"],
	["started_at", "string"],
	["completed_at", "stringNull"],
	["stop_reason", "stringNull"],
	["session_id", "string"],
	["last_session_file", "stringNull"],
	["owner_pid", "intNull"],
	["owner_heartbeat_at", "stringNull"],
	["error_count", "int"],
	["transitioning", "bool"],
	["cancel_requested", "bool"],
	["stop_requested", "bool"],
	["bundle_mode", "bool"],
	["loop_token", "token"],
	["model_provider", "stringNull"],
	["model_id", "stringNull"],
	["thinking_level", "stringNull"],
	["bundle_snapshot_hash", "stringNull"],
	["items_snapshot_hash", "stringNull"],
	["progress_size", "intNull"],
	["progress_hash", "stringNull"],
	["progress_snapshot", "stringNull"],
	["source_doc_hashes", "stringNull"],
	["bundle_items_snapshot", "stringNull"],
	["git_head", "stringNull"],
	["bundle_rejection_count", "int"],
	["provider_recovery_fresh_fallback_used", "bool"],
	["limit_reminders", "stringNull"],
] as const satisfies ReadonlyArray<readonly [keyof RalphLoopState, FieldKind]>;

// Compile-time proof that the descriptor names every RalphLoopState field.
// If a field is added to the interface but not to STATE_SCHEMA, _MissingFields
// becomes that key and this assignment fails to compile.
type _MissingFields = Exclude<
	keyof RalphLoopState,
	(typeof STATE_SCHEMA)[number][0]
>;
const _stateSchemaIsComplete: _MissingFields extends never ? true : false =
	true;
void _stateSchemaIsComplete;

/**
 * Serialize a frontmatter value to its YAML-compatible scalar representation.
 */
function serializeValue(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	return JSON.stringify(String(value));
}

/**
 * Split a state file into frontmatter and body. The closing delimiter must be a
 * complete line, not a substring inside a serialized value.
 */
function frontmatterParts(
	content: string,
): { frontmatter: string; body: string } | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
	if (!match) return null;
	return {
		frontmatter: match[1],
		body: content.slice(match[0].length).trim(),
	};
}

/**
 * Parse a YAML frontmatter value string into a typed value.
 */
function parseValue(
	raw: string,
	key?: string,
): string | number | boolean | null {
	const trimmed = raw.trim();
	if (trimmed === "null") return null;
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
	if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		const unquoted = trimmed.slice(1, -1);
		// Legacy state files used raw quoted strings. A Windows path such as
		// "C:\new\table" is valid JSON, but JSON.parse would turn \n and \t
		// into control characters. New writes escape those backslashes as \\.
		if (key === "last_session_file" && /^[A-Za-z]:\\(?!\\)/.test(unquoted)) {
			return unquoted;
		}
		try {
			return JSON.parse(trimmed) as string;
		} catch {
			return unquoted;
		}
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseFrontmatter(frontmatter: string): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	for (const line of frontmatter.split("\n")) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;
		const key = line.slice(0, colonIndex).trim();
		const value = line.slice(colonIndex + 1).trim();
		data[key] = parseValue(value, key);
	}
	return data;
}

function coerceState(data: Record<string, unknown>): RalphLoopState {
	const state: Record<string, unknown> = {};
	for (const [key, kind] of STATE_SCHEMA) {
		state[key] = FIELD_KINDS[kind].coerce(data[key]);
	}
	return state as unknown as RalphLoopState;
}

const nonEmptyString = (value: unknown) =>
	typeof value === "string" && value.length > 0;

// These fields establish run identity and liveness. Never default them in
// observations. Each carries its strict check and the reason it reports.
const ESSENTIAL_FIELDS = [
	{ key: "running", strict: (value: unknown) => typeof value === "boolean", reason: "invalid" },
	{ key: "iteration", strict: (value: unknown) => typeof value === "number", reason: "invalid" },
	{ key: "started_at", strict: nonEmptyString, reason: "empty" },
	{ key: "loop_token", strict: nonEmptyString, reason: "empty" },
] as const satisfies readonly {
	key: keyof RalphLoopState;
	strict: (value: unknown) => boolean;
	reason: string;
}[];

/** A wrong raw type is invalid; a right type that fails the strict check uses the entry reason. */
function essentialProblem(
	data: Record<string, unknown>,
	fields: Record<string, unknown>,
): string | null {
	for (const { key, strict, reason } of ESSENTIAL_FIELDS) {
		if (!(key in data)) return `missing field: ${key}`;
		if (!(key in fields)) return `invalid field: ${key}`;
		if (!strict(data[key])) return `${reason} field: ${key}`;
	}
	return null;
}

/** Detailed state-file observation without inventing missing run identity. */
export type StateDocument =
	| { status: "missing" }
	| {
			status: "partial";
			reason: string;
			body: string | null;
			fields: Partial<RalphLoopState>;
	  }
	| { status: "valid"; state: RalphLoopState; body: string };

/** Read the loop state without treating incomplete writes as stopped loops. */
export function readStateDocument(cwd: string): StateDocument {
	const filePath = join(cwd, STATE_FILE);
	if (!existsSync(filePath)) return { status: "missing" };
	try {
		const parts = frontmatterParts(readFileSync(filePath, "utf-8"));
		if (!parts) {
			return { status: "partial", reason: "no front matter", body: null, fields: {} };
		}
		const data = parseFrontmatter(parts.frontmatter);
		const rawFields: Record<string, unknown> = {};
		for (const [key, kind] of STATE_SCHEMA) {
			if (FIELD_KINDS[kind].accepts(data[key])) rawFields[key] = data[key];
		}
		// STATE_SCHEMA ties each key to its raw type, checked above without coercion.
		const fields = rawFields as Partial<RalphLoopState>;
		const reason = essentialProblem(data, rawFields);
		if (reason) return { status: "partial", reason, body: parts.body, fields };
		return { status: "valid", state: coerceState(data), body: parts.body };
	} catch (error) {
		return {
			status: "partial",
			reason: `read error: ${error instanceof Error ? error.message : String(error)}`,
			body: null,
			fields: {},
		};
	}
}

/**
 * Read and parse the Ralph loop state file.
 *
 * @param cwd - Project working directory
 * @returns Parsed state or null if file doesn't exist or is malformed
 */
export function readState(cwd: string): RalphLoopState | null {
	const filePath = join(cwd, STATE_FILE);
	if (!existsSync(filePath)) return null;

	try {
		const content = readFileSync(filePath, "utf-8");
		const parts = frontmatterParts(content);
		if (!parts) return null;

		return coerceState(parseFrontmatter(parts.frontmatter));
	} catch {
		return null;
	}
}

/**
 * Write the full state file with frontmatter and task body.
 *
 * @param cwd - Project working directory
 * @param state - Loop state to write
 * @param taskBody - The raw task prompt (body after frontmatter)
 */
export function writeState(
	cwd: string,
	state: RalphLoopState,
	taskBody: string,
): void {
	const dirPath = join(cwd, ".ralph");
	if (!existsSync(dirPath)) {
		mkdirSync(dirPath, { recursive: true });
	}

	const frontmatter = [
		"---",
		...STATE_SCHEMA.map(([key]) => `${key}: ${serializeValue(state[key])}`),
		"---",
	].join("\n");

	const content = `${frontmatter}\n\n${taskBody}\n`;
	writeFileSync(join(cwd, STATE_FILE), content, "utf-8");
}

/**
 * Read, merge partial updates, and write back the state file.
 * Preserves the task body.
 *
 * @param cwd - Project working directory
 * @param updates - Partial state fields to merge
 */
export function updateState(
	cwd: string,
	updates: Partial<RalphLoopState>,
): void {
	const current = readState(cwd);
	if (!current) return;

	const body = getTaskBody(cwd) ?? "";
	const merged = { ...current, ...updates };
	writeState(cwd, merged, body);
}

/**
 * Read just the task body (after frontmatter) from the state file.
 *
 * @param cwd - Project working directory
 * @returns The task body text or null if file doesn't exist
 */
export function getTaskBody(cwd: string): string | null {
	const filePath = join(cwd, STATE_FILE);
	if (!existsSync(filePath)) return null;

	try {
		const content = readFileSync(filePath, "utf-8");
		const parts = frontmatterParts(content);
		if (!parts) return null;

		return parts.body;
	} catch {
		return null;
	}
}
