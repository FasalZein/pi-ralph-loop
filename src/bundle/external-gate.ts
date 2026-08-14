import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveWorkspacePath, validateRequiredFile } from "./paths.js";
import type { RalphBundle } from "./types.js";

export const EXTERNAL_GATE_PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;

export type ExternalGateHook =
	| "dry-run"
	| "launch"
	| "iteration-start"
	| "promise"
	| "transition"
	| "stop"
	| "cleanup";

export type ExternalGateDigests = {
	entrypoint: string;
	immutable_bundle: string;
};

export type ExternalGateInput = {
	version: 1;
	hook: ExternalGateHook;
	workspace_root: string;
	digests: ExternalGateDigests;
	heads: {
		start: string | null;
		current: string | null;
		accepted: string | null;
	};
	loop: {
		token: string | null;
		iteration: number;
		max_iterations: number;
		started_at: string | null;
		session_id: string | null;
		stop_reason: string | null;
	};
	promise?: "NEXT" | "COMPLETE";
	resume?: {
		same_token: boolean;
		same_session: boolean;
	};
};

export type ExternalGateResponse = {
	version: 1;
	phase: ExternalGateHook;
	mode: string;
	selected_issue: string | null;
	selected_title: string | null;
	start_head: string | null;
	current_head: string | null;
	accepted_head: string | null;
	checks: Array<{
		name: string;
		status: "pass" | "fail" | "skip";
		detail: string;
	}>;
	journal_phase: string | null;
	linear_action: string | null;
	exit_code: 0 | 2 | 3 | 4 | 5 | 6 | 7;
	ok: boolean;
	message?: string;
};

function hash(value: string | NodeJS.ArrayBufferView): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, child]) => [key, canonicalize(child)]),
	);
}

function immutableItems(bundle: RalphBundle): unknown[] {
	return bundle.items.items.map(({ passes, regression_notes, ...item }) => item);
}

export function resolveExternalGateEntrypoint(
	bundle: RalphBundle,
): string | null {
	const config = bundle.items.runtime_contract?.external_gate;
	if (!config) return null;
	if (path.isAbsolute(config.entrypoint)) {
		throw new Error("Invalid Ralph bundle: runtime_contract.external_gate.entrypoint must be repository-relative");
	}
	if (path.extname(config.entrypoint) !== ".mjs") {
		throw new Error("Invalid Ralph bundle: runtime_contract.external_gate.entrypoint must end in .mjs");
	}
	resolveWorkspacePath(bundle.root, config.entrypoint);
	return validateRequiredFile(bundle.root, config.entrypoint);
}

export function createExternalGateDigests(
	bundle: RalphBundle,
): ExternalGateDigests | null {
	const entrypoint = resolveExternalGateEntrypoint(bundle);
	if (!entrypoint) return null;
	const rawItems = JSON.parse(
		readFileSync(bundle.files[".ralph/items.json"], "utf8"),
	) as Record<string, unknown>;
	const immutableBundle = {
		plan: readFileSync(bundle.files[".ralph/plan.md"], "utf8"),
		prompt: readFileSync(bundle.files[".ralph/prompt.md"], "utf8"),
		runtime_contract: rawItems.runtime_contract ?? {},
		items: immutableItems(bundle),
	};
	return {
		entrypoint: hash(readFileSync(entrypoint)),
		immutable_bundle: hash(JSON.stringify(canonicalize(immutableBundle))),
	};
}

function nullableString(value: unknown): boolean {
	return value === null || (typeof value === "string" && value.length > 0);
}

function validChecks(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every(
			(check) =>
				check &&
				typeof check === "object" &&
				!Array.isArray(check) &&
				Object.keys(check).every((key) =>
					["name", "status", "detail"].includes(key),
				) &&
				typeof check.name === "string" &&
				check.name.length > 0 &&
				["pass", "fail", "skip"].includes(check.status) &&
				typeof check.detail === "string",
		)
	);
}

function validResponse(output: unknown, hook: ExternalGateHook): output is ExternalGateResponse {
	if (!output || typeof output !== "object" || Array.isArray(output)) return false;
	const value = output as Record<string, unknown>;
	const allowed = [
		"version",
		"phase",
		"mode",
		"selected_issue",
		"selected_title",
		"start_head",
		"current_head",
		"accepted_head",
		"checks",
		"journal_phase",
		"linear_action",
		"exit_code",
		"ok",
		"message",
	];
	return (
		Object.keys(value).every((key) => allowed.includes(key)) &&
		value.version === 1 &&
		value.phase === hook &&
		typeof value.mode === "string" &&
		value.mode.length > 0 &&
		nullableString(value.selected_issue) &&
		nullableString(value.selected_title) &&
		(value.selected_issue === null) === (value.selected_title === null) &&
		nullableString(value.start_head) &&
		nullableString(value.current_head) &&
		nullableString(value.accepted_head) &&
		validChecks(value.checks) &&
		nullableString(value.journal_phase) &&
		nullableString(value.linear_action) &&
		[0, 2, 3, 4, 5, 6, 7].includes(value.exit_code as number) &&
		typeof value.ok === "boolean" &&
		(value.ok === (value.exit_code === 0)) &&
		(value.message === undefined || typeof value.message === "string")
	);
}

export function runExternalGate(
	bundle: RalphBundle,
	input: ExternalGateInput,
): string | null {
	const config = bundle.items.runtime_contract?.external_gate;
	if (!config) return null;
	const entrypoint = resolveExternalGateEntrypoint(bundle);
	if (!entrypoint) return null;

	const result = spawnSync(process.execPath, [entrypoint], {
		cwd: bundle.root,
		input: `${JSON.stringify(input)}\n`,
		encoding: "utf8",
		timeout: config.timeout_ms ?? DEFAULT_TIMEOUT_MS,
		maxBuffer: 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		return code === "ETIMEDOUT"
			? `external gate ${input.hook} timed out`
			: `external gate ${input.hook} failed: ${result.error.message}`;
	}
	if (result.signal) {
		return `external gate ${input.hook} terminated by signal ${result.signal}`;
	}
	if (result.status !== 0) {
		return `external gate ${input.hook} exited with code ${result.status}`;
	}

	let output: unknown;
	try {
		output = JSON.parse(result.stdout.trim());
	} catch {
		return `external gate ${input.hook} returned malformed JSON`;
	}
	if (!validResponse(output, input.hook)) {
		return `external gate ${input.hook} returned an invalid protocol document`;
	}
	if (!output.ok) {
		return (
			output.message ||
			`external gate ${input.hook} rejected the lifecycle event with exit code ${output.exit_code}`
		);
	}
	return null;
}
