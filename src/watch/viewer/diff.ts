import { spawn } from "node:child_process";
import { clean, style } from "./layout.js";

// Authority: owner Q3 `cap-1mib` on #16: one Diff view reads at most 1 MiB of git output.
export const DIFF_CAP_BYTES = 1024 * 1024;
// Full object names only (SHA-1 or SHA-256); never a name taken from progress text.
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type ShownCommit = { readonly text: string; readonly truncated: boolean };
export type ShowCommit = (root: string, sha: string, signal: AbortSignal) => Promise<ShownCommit>;

/**
 * `git show` of one verified commit, read-only and bounded. It uses the flags of
 * `ObservationRuntime.git` (`--no-optional-locks`, `diff.autoRefreshIndex=false`,
 * `GIT_OPTIONAL_LOCKS=0`), but stops reading at `DIFF_CAP_BYTES`, which the shared
 * boundary cannot do: it buffers the whole output. Colour, external diff and textconv
 * are off so only plain text reaches the renderer. Merges show the first-parent diff (T10 D5).
 */
export const showCommit: ShowCommit = (root, sha, signal) => new Promise((resolve, reject) => {
	if (!FULL_SHA.test(sha)) { reject(new Error("not a full commit id")); return; }
	const args = ["show", "--no-color", "--no-ext-diff", "--no-textconv", "--diff-merges=first-parent", "--format=commit %H%n%s%n", "--end-of-options", sha, "--"];
	const child = spawn("git", ["--no-optional-locks", "-c", "diff.autoRefreshIndex=false", ...args], {
		cwd: root, shell: false, signal, stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
	});
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	let size = 0;
	let truncated = false;
	child.stdout.on("data", (chunk: Buffer) => {
		if (truncated) return;
		out.push(chunk);
		size += chunk.length;
		if (size >= DIFF_CAP_BYTES) { truncated = true; child.kill(); }
	});
	child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
	child.on("error", reject);
	child.on("close", (code) => {
		if (truncated) {
			const text = Buffer.concat(out).subarray(0, DIFF_CAP_BYTES).toString("utf8");
			// Drop the partial last line.
			resolve({ text: text.slice(0, Math.max(0, text.lastIndexOf("\n"))), truncated: true });
		} else if (code === 0) resolve({ text: Buffer.concat(out).toString("utf8"), truncated: false });
		else reject(new Error(`git show exited ${code}: ${Buffer.concat(err).toString("utf8").trim()}`));
	});
});

/**
 * Coloured diff lines. Each git line is sanitized first; then trusted colour is added by its
 * prefix: file headers bold, hunk headers accent, additions green, removals red.
 */
export function diffLines(shown: ShownCommit): string[] {
	const lines = shown.text.replace(/\n$/, "").split("\n").map((raw) => {
		const line = clean(raw);
		if (/^(diff --git |index |--- |\+\+\+ |commit [0-9a-f]+$)/.test(raw)) return style.bold(line);
		if (raw.startsWith("@@")) return style.accent(line);
		if (raw.startsWith("+")) return style.green(line);
		if (raw.startsWith("-")) return style.red(line);
		return line;
	});
	if (shown.truncated) lines.push(style.yellow("⚠ diff truncated at 1 MiB of git output"));
	return lines;
}
