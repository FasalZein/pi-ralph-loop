import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	getTaskBody,
	readState,
	readStateDocument,
	updateState,
	writeState,
} from "../src/state.ts";
import type { RalphLoopState } from "../src/types.ts";

function makeState(): RalphLoopState {
	return {
		running: true,
		iteration: 2,
		max_iterations: 5,
		started_at: "2026-04-08T00:00:00.000Z",
		completed_at: null,
		stop_reason: null,
		session_id: "session-1",
		last_session_file: "/sessions/session-1.jsonl",
		owner_pid: null,
		owner_heartbeat_at: null,
		error_count: 1,
		transitioning: false,
		cancel_requested: false,
		stop_requested: false,
		bundle_mode: false,
		loop_token: "token-1",
		model_provider: null,
		model_id: null,
		thinking_level: null,
		bundle_snapshot_hash: null,
		items_snapshot_hash: null,
		progress_size: null,
		progress_hash: null,
		progress_snapshot: null,
		source_doc_hashes: null,
		bundle_items_snapshot: null,
		git_head: null,
		bundle_rejection_count: 0,
		provider_recovery_fresh_fallback_used: false,
		limit_reminders: null,
	};
}

test("state round-trips and preserves task body", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-"));
	const state = makeState();
	const task = "implement feature x";

	writeState(cwd, state, task);

	assert.deepEqual(readState(cwd), state);
	assert.equal(getTaskBody(cwd), task);

	updateState(cwd, {
		iteration: 3,
		stop_requested: true,
	});

	assert.deepEqual(readState(cwd), {
		...state,
		iteration: 3,
		stop_requested: true,
	});
	assert.equal(getTaskBody(cwd), task);
});

test("state body parsing ignores frontmatter string contents", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-frontmatter-"));
	const state = makeState();
	state.bundle_items_snapshot = JSON.stringify([
		{ description: "finding text\n---\ninside serialized snapshot" },
	]);
	const task = "real bundle prompt";

	writeState(cwd, state, task);

	assert.deepEqual(readState(cwd), state);
	assert.equal(getTaskBody(cwd), task);

	updateState(cwd, { iteration: 4 });
	assert.equal(getTaskBody(cwd), task);
});

test("state body preserves delimiter lines in the task prompt", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-body-delimiter-"));
	const state = makeState();
	const task = "---\nbody starts with a delimiter\n---\nbody contains one too";

	writeState(cwd, state, task);

	assert.equal(getTaskBody(cwd), task);
	updateState(cwd, { iteration: 4 });
	assert.equal(getTaskBody(cwd), task);
});

test("legacy raw Windows session paths parse without JSON escape rewriting", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-windows-path-"));
	const legacySessionFile = String.raw`C:\new\table\session.jsonl`;
	mkdirSync(join(cwd, ".ralph"), { recursive: true });
	writeFileSync(
		join(cwd, ".ralph", "loop.md"),
		[
			"---",
			"running: true",
			"iteration: 1",
			"max_iterations: 3",
			'started_at: "2026-04-08T00:00:00.000Z"',
			"completed_at: null",
			"stop_reason: null",
			'session_id: "session-1"',
			`last_session_file: "${legacySessionFile}"`,
			"error_count: 0",
			"transitioning: false",
			"cancel_requested: false",
			"stop_requested: false",
			"---",
			"",
			"legacy task",
			"",
		].join("\n"),
		"utf8",
	);

	assert.equal(readState(cwd)?.last_session_file, legacySessionFile);
});

test("old state files parse with default bundle metadata", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-old-"));
	mkdirSync(join(cwd, ".ralph"), { recursive: true });
	writeFileSync(
		join(cwd, ".ralph", "loop.md"),
		[
			"---",
			"running: true",
			"iteration: 1",
			"max_iterations: 3",
			'started_at: "2026-04-08T00:00:00.000Z"',
			"completed_at: null",
			"stop_reason: null",
			'session_id: "session-1"',
			"last_session_file: null",
			"error_count: 0",
			"transitioning: false",
			"cancel_requested: false",
			"stop_requested: false",
			"---",
			"",
			"legacy task",
			"",
		].join("\n"),
		"utf8",
	);

	const state = readState(cwd);
	assert.equal(state?.bundle_mode, false);
	assert.ok(state?.loop_token);
	assert.equal(state?.owner_pid, null);
	assert.equal(state?.owner_heartbeat_at, null);
	assert.equal(state?.model_provider, null);
	assert.equal(state?.model_id, null);
	assert.equal(state?.thinking_level, null);
	assert.equal(state?.bundle_snapshot_hash, null);
	assert.equal(state?.items_snapshot_hash, null);
	assert.equal(state?.progress_size, null);
	assert.equal(state?.progress_hash, null);
	assert.equal(state?.progress_snapshot, null);
	assert.equal(state?.source_doc_hashes, null);
	assert.equal(state?.git_head, null);
	assert.equal(state?.bundle_rejection_count, 0);
	assert.equal(state?.limit_reminders, null);
	assert.equal(getTaskBody(cwd), "legacy task");
});


test("readStateDocument reports missing when no state file exists", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-document-"));
	assert.deepEqual(readStateDocument(cwd), { status: "missing" });
});

test("readStateDocument returns valid state and body for a written state", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-document-"));
	const state = makeState();
	writeState(cwd, state, "task");
	assert.deepEqual(readStateDocument(cwd), { status: "valid", state, body: "task" });
});

test("readStateDocument reports partial for half-written front matter", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-document-"));
	mkdirSync(join(cwd, ".ralph"));
	writeFileSync(join(cwd, ".ralph", "loop.md"), "---\nrunning: true\niteration: 2\n");
	assert.deepEqual(readStateDocument(cwd), {
		status: "partial", reason: "no front matter", body: null, fields: {},
	});
	assert.equal(readState(cwd), null);
});

test("readStateDocument reports partial, not running:false, when essential fields are absent", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-document-"));
	mkdirSync(join(cwd, ".ralph"));
	writeFileSync(join(cwd, ".ralph", "loop.md"), "---\niteration: 1\n---\ntask");
	assert.deepEqual(readStateDocument(cwd), {
		status: "partial", reason: "missing field: running", body: "task", fields: { iteration: 1 },
	});
	assert.equal(readState(cwd)?.running, false);
});

test("readStateDocument never invents a loop token", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-document-"));
	writeState(cwd, makeState(), "task");
	writeFileSync(join(cwd, ".ralph", "loop.md"), '---\nrunning: true\niteration: 2\nstarted_at: "2026-04-08"\n---\ntask');
	const first = readStateDocument(cwd);
	assert.equal(first.status, "partial");
	if (first.status !== "partial") assert.fail("expected partial state");
	assert.equal(first.reason, "missing field: loop_token");
	assert.equal(first.fields.loop_token, undefined);
	assert.deepEqual(readStateDocument(cwd), first);
	assert.ok(readState(cwd)?.loop_token);
});

test("readStateDocument validates each essential field without coercing raw fields", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-document-"));
	mkdirSync(join(cwd, ".ralph"));
	const essential = { running: "false", iteration: "0", started_at: '"date"', loop_token: '"token"' };
	for (const key of ["running", "iteration", "started_at", "loop_token"] as const) {
		for (const value of [undefined, "null", '""']) {
			const entries = { ...essential, [key]: value };
			writeFileSync(join(cwd, ".ralph", "loop.md"), [
				"---",
				...Object.entries(entries).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`),
				"owner_pid: null", "max_iterations: false", "unknown: true", "---", "task",
			].join("\n"));
			const result = readStateDocument(cwd);
			assert.equal(result.status, "partial", `${key}: ${value}`);
			if (result.status !== "partial") assert.fail("expected partial state");
			assert.match(result.reason, new RegExp(`field: ${key}$`));
			assert.equal(result.fields.owner_pid, null);
			assert.equal(result.fields.max_iterations, undefined);
			assert.ok(!("unknown" in result.fields));
			assert.equal(result.fields[key], value === '""' && (key === "started_at" || key === "loop_token") ? "" : undefined);
		}
	}
});

test("readStateDocument defaults only nonessential fields for valid documents", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-document-"));
	mkdirSync(join(cwd, ".ralph"));
	writeFileSync(join(cwd, ".ralph", "loop.md"), '---\r\nrunning: false\r\niteration: 0\r\nstarted_at: "date"\r\nloop_token: "token"\r\n---\r\ntask');
	const result = readStateDocument(cwd);
	assert.equal(result.status, "valid");
	if (result.status !== "valid") assert.fail("expected valid state");
	assert.deepEqual(result.state, readState(cwd));
	assert.equal(result.state.running, false);
	assert.equal(result.state.max_iterations, 0);
	assert.equal(result.state.owner_pid, null);
	assert.equal(result.body, "task");
});

test("readStateDocument reports read errors as partial", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-document-"));
	mkdirSync(join(cwd, ".ralph", "loop.md"), { recursive: true });
	const result = readStateDocument(cwd);
	assert.equal(result.status, "partial");
	if (result.status !== "partial") assert.fail("expected partial state");
	assert.match(result.reason, /^read error:/);
	assert.equal(result.body, null);
	assert.deepEqual(result.fields, {});
	assert.equal(readState(cwd), null);
});

test("readStateDocument names wrong-type and empty essential fields distinctly", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ralph-state-document-"));
	mkdirSync(join(cwd, ".ralph"));
	const cases: [string, string][] = [
		['running: false\niteration: 0\nstarted_at: ""\nloop_token: "t"', "empty field: started_at"],
		['running: false\niteration: 0\nstarted_at: 5\nloop_token: "t"', "invalid field: started_at"],
		['running: "yes"\niteration: 0\nstarted_at: "d"\nloop_token: "t"', "invalid field: running"],
		['running: false\niteration: 0\nstarted_at: "d"\nloop_token: ""', "empty field: loop_token"],
	];
	for (const [front, reason] of cases) {
		writeFileSync(join(cwd, ".ralph", "loop.md"), `---\n${front}\n---\ntask`);
		const result = readStateDocument(cwd);
		assert.equal(result.status === "partial" ? result.reason : result.status, reason);
	}
	// Legacy reader still replaces an empty token with a generated one.
	assert.match(readState(cwd)?.loop_token ?? "", /^[0-9a-f-]{36}$/);
});
