import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeState } from "../../src/state.ts";
import type { RalphLoopState } from "../../src/types.ts";
import { defaultRuntime, openLoop, type ObservationRuntime } from "../../src/watch/loop-state.ts";

export const T = (hhmm: string) => `2026-09-30T${hhmm}:00.000Z`;

export type Item = { id?: string; description?: string; passes: boolean; regression_notes?: string; title?: string };

export class Fixture {
	readonly root = realpathSync(mkdtempSync(path.join(tmpdir(), "ralph-loop-state-")));
	items: Item[];
	progress = "";
	constructor(items: Item[], opts: { mission?: boolean; blocker?: boolean; plain?: boolean } = {}) {
		this.items = items;
		this.git("init", "-q");
		this.git("commit", "--allow-empty", "-qm", "initial");
		mkdirSync(path.join(this.root, ".ralph"));
		writeFileSync(path.join(this.root, ".gitignore"), ".ralph/loop.md\n");
		for (const f of ["plan.md", "prompt.md"]) writeFileSync(path.join(this.root, ".ralph", f), "text\n");
		if (opts.mission !== false) {
			writeFileSync(path.join(this.root, ".ralph/mission.json"), JSON.stringify({
				version: 1, task: opts.plain ? { kind: "plain", prompt: "Do it." } : { kind: "bundle" },
				run: { model: "m", thinking: "off", maxIterations: 9, budgetAuthority: "Test" },
				git: { baseCommit: this.git("rev-parse", "HEAD") }, rules: {}, host: { prefer: ["tmux"] },
				blocker: opts.blocker === false ? null : { subjectRegex: "^blocked\\((?<item>[^)]+)\\)", itemGroup: "item" },
			}));
		}
		this.writeBundle();
		this.commit("setup", T("09:00"));
	}
	git(...args: string[]): string {
		return execFileSync("git", ["--no-optional-locks", "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], {
			cwd: this.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...this.env },
		}).trim();
	}
	env: Record<string, string> = {};
	writeBundle(): void {
		writeFileSync(path.join(this.root, ".ralph/items.json"), JSON.stringify({ version: 1, items: this.items.map((i) => ({
			category: "c", description: i.description ?? `do ${i.id}`, steps: ["s"], regression_notes: "", ...i,
		})) }));
		writeFileSync(path.join(this.root, ".ralph/progress.md"), this.progress);
	}
	commit(subject: string, at: string): string {
		this.env = { GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at };
		this.git("add", "-A");
		this.git("commit", "--allow-empty", "-qm", subject);
		return this.git("rev-parse", "HEAD");
	}
	pass(id: string, at: string, entry = `# ${id} passed: done\n- Checks: types exit=0.\n`): string {
		this.items = this.items.map((i) => (i.id === id ? { ...i, passes: true } : i));
		this.progress += entry;
		this.writeBundle();
		return this.commit(`feat: ${id}`, at);
	}
	block(id: string, at: string, entry = `# ${id} blocked: gate\n- Failing command: \`npm test\` exit 1.\n`): string {
		this.progress += entry;
		this.writeBundle();
		return this.commit(`blocked(${id}): gate`, at);
	}
	state(running: boolean, startedAt: string, token = "run-a", extra: Partial<RalphLoopState> = {}): void {
		writeState(this.root, {
			running, iteration: 1, max_iterations: 9, started_at: startedAt, completed_at: running ? null : startedAt,
			stop_reason: null, session_id: "s", last_session_file: null, owner_pid: null, owner_heartbeat_at: null,
			error_count: 0, transitioning: false, cancel_requested: false, stop_requested: false, bundle_mode: true,
			loop_token: token, model_provider: null, model_id: null, thinking_level: null, bundle_snapshot_hash: null,
			items_snapshot_hash: null, progress_size: null, progress_hash: null, progress_snapshot: null,
			source_doc_hashes: null, bundle_items_snapshot: null, git_head: null, bundle_rejection_count: 0,
			provider_recovery_fresh_fallback_used: false, limit_reminders: null, ...extra,
		}, "task");
	}
	close(): void { rmSync(this.root, { recursive: true, force: true }); }
}

export function clock(at = T("12:00")): ObservationRuntime {
	return { ...defaultRuntime, now: () => new Date(at) };
}

export async function readOnce(f: Fixture, runtime: ObservationRuntime = clock()) {
	const reader = openLoop(f.root, { runtime });
	try { return await reader.read(); } finally { await reader.close(); }
}

export const statuses = (s: Awaited<ReturnType<typeof readOnce>>) => Object.fromEntries(s.items.map((i) => [i.key, i.status]));

/** Runtime that runs `inject` once, right after the first `rev-list`. */
export function midRead(inject: () => void, base: ObservationRuntime = clock()): ObservationRuntime {
	let done = false;
	return {
		...base,
		async git(root, args, signal) {
			const out = await base.git(root, args, signal);
			if (!done && args[0] === "rev-list") { done = true; inject(); }
			return out;
		},
	};
}
