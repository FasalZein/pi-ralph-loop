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

const COERCE: Record<FieldKind, (value: unknown) => unknown> = {
	bool: (value) => value === true,
	int: (value) => (typeof value === "number" ? value : 0),
	intNull: (value) => (typeof value === "number" ? value : null),
	string: (value) => (typeof value === "string" ? value : ""),
	stringNull: (value) => (typeof value === "string" ? value : null),
	token: (value) =>
		typeof value === "string" && value.length > 0 ? value : randomUUID(),
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
		state[key] = COERCE[kind](data[key]);
	}
	return state as unknown as RalphLoopState;
}

// These fields establish run identity and liveness. Never default them in observations.
const ESSENTIAL_FIELDS = [
	"running",
	"iteration",
	"started_at",
	"loop_token",
] as const satisfies readonly (keyof RalphLoopState)[];

function hasRawType(kind: FieldKind, value: unknown): boolean {
	switch (kind) {
		case "bool":
			return typeof value === "boolean";
		case "int":
			return typeof value === "number";
		case "intNull":
			return value === null || typeof value === "number";
		case "string":
		case "token":
			return typeof value === "string";
		case "stringNull":
			return value === null || typeof value === "string";
	}
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
			if (hasRawType(kind, data[key])) rawFields[key] = data[key];
		}
		// STATE_SCHEMA ties each key to its raw type, checked above without coercion.
		const fields = rawFields as Partial<RalphLoopState>;
		for (const key of ESSENTIAL_FIELDS) {
			let reason: string | null = null;
			if (!(key in data)) reason = `missing field: ${key}`;
			else if (!(key in fields)) reason = `invalid field: ${key}`;
			else if ((key === "started_at" || key === "loop_token") && data[key] === "") {
				reason = `empty field: ${key}`;
			}
			if (reason) return { status: "partial", reason, body: parts.body, fields };
		}
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
