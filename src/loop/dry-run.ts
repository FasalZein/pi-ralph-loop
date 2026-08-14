import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
} from "node:fs";
import path from "node:path";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type DryRunSnapshot = {
	gitHead: string | null;
	gitStatus: string | null;
	ralphTree: string;
	sessionId: string;
	sessionFile: string | null;
};

function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

function hashTree(root: string): string {
	const hash = createHash("sha256");
	if (!existsSync(root)) return hash.update("missing").digest("hex");

	function visit(current: string, relative: string): void {
		const stat = lstatSync(current);
		hash.update(
			JSON.stringify({
				path: relative,
				mode: stat.mode,
				size: stat.size,
				mtime_ms: stat.mtimeMs,
				type: stat.isDirectory()
					? "directory"
					: stat.isSymbolicLink()
						? "symlink"
						: "file",
			}),
		);
		if (stat.isSymbolicLink()) {
			hash.update(readlinkSync(current));
			return;
		}
		if (stat.isDirectory()) {
			for (const name of readdirSync(current).sort()) {
				visit(path.join(current, name), path.posix.join(relative, name));
			}
			return;
		}
		hash.update(readFileSync(current));
	}

	visit(root, ".ralph");
	return hash.digest("hex");
}

export function captureDryRunSnapshot(
	ctx: ExtensionCommandContext,
): DryRunSnapshot {
	return {
		gitHead: git(ctx.cwd, ["rev-parse", "HEAD"])?.trim() ?? null,
		gitStatus:
			git(ctx.cwd, ["status", "--porcelain=v1", "--untracked-files=all"]) ??
			null,
		ralphTree: hashTree(path.join(ctx.cwd, ".ralph")),
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile() ?? null,
	};
}

export function compareDryRunSnapshots(
	before: DryRunSnapshot,
	after: DryRunSnapshot,
	phase = "dry-run",
): string | null {
	const changed = (Object.keys(before) as Array<keyof DryRunSnapshot>).filter(
		(key) => before[key] !== after[key],
	);
	return changed.length
		? `Ralph external gate ${phase} mutated protected state: ${changed.join(", ")}`
		: null;
}
