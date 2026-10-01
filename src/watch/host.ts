import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { object } from "./journal.js";

/** Exact identity of the terminal session that hosts one launch. The display name is never identity. */
export type HostHandle = {
	readonly v: 1;
	readonly kind: "tmux";
	readonly root: string;
	readonly launchId: string;
	readonly name: string;
	/** Absolute tmux server socket path, captured at creation. */
	readonly socket: string;
	readonly sessionId: string;
	readonly windowId: string;
	readonly paneId: string;
	readonly createdAt: string;
};
/** One role process. `argv` is passed to the host without a shell. */
export type RoleSpec = { readonly title: "loop"; readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>> };
export type Host = {
	/**
	 * Create the session and start the role. `signal` is the absolute startup
	 * deadline and also bounds cleanup: on failure the adapter removes the
	 * session it created, which never ran a loop, and rethrows; if the deadline
	 * leaves no time for that, it throws HostOpenError instead.
	 */
	open(root: string, launchId: string, role: RoleSpec, signal?: AbortSignal): Promise<HostHandle>;
	/** True when the handle still names the same live session, pane, root and launch on the same server. */
	verify(handle: HostHandle, signal?: AbortSignal): Promise<boolean>;
	/**
	 * True only on positive evidence: this launch's pane reports its process
	 * exited, or the server proves the pane absent. Throws when the answer is
	 * uncertain (query failure, malformed or mismatched output).
	 */
	paneDead(handle: HostHandle, signal?: AbortSignal): Promise<boolean>;
	/**
	 * Close the exact session after it verifies. Callers authorize it: either
	 * the role never dispatched a launch, or fresh state proves the loop idle.
	 */
	close(handle: HostHandle, signal?: AbortSignal): Promise<void>;
};
/**
 * `open` failed and could not remove its session within the caller's startup
 * deadline. `handle` is the exact creation identity when it was observed, so
 * the caller can keep a record for the next launch's recovery.
 */
export class HostOpenError extends Error {
	constructor(cause: string, readonly retained: string, readonly handle: HostHandle | null) { super(`${cause}; ${retained}`); this.name = "HostOpenError"; }
}

const RECORD = ".ralph/watch-host.json";
function valid(value: unknown): value is HostHandle {
	return object(value) && value.v === 1 && value.kind === "tmux" && ["root", "launchId", "name", "socket", "sessionId", "windowId", "paneId", "createdAt"].every((key) => typeof value[key] === "string");
}
/** Atomic write; never replaces the record of another launch. */
export function writeHostRecord(handle: HostHandle): void {
	const path = join(handle.root, RECORD);
	const current = readHostRecord(handle.root);
	if (current && current.launchId !== handle.launchId) throw new Error(`Host record belongs to launch ${current.launchId}`);
	const temporary = `${path}.${process.pid}.tmp`;
	try { writeFileSync(temporary, JSON.stringify(handle), { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
	finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
/** Null when missing; throws for a symlink, non-regular or malformed record. */
export function readHostRecord(root: string): HostHandle | null {
	const path = join(root, RECORD);
	if (!existsSync(path)) return null;
	if (!lstatSync(path).isFile()) throw new Error(`Host record is not a regular file: ${path}`);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	let value: unknown;
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`Host record is not a regular file: ${path}`);
		value = JSON.parse(readFileSync(fd, "utf8"));
	} finally { closeSync(fd); }
	if (!valid(value) || value.root !== root) throw new Error(`Host record is malformed: ${path}`);
	return value;
}
export function removeHostRecord(root: string, launchId: string): void {
	if (readHostRecord(root)?.launchId === launchId) unlinkSync(join(root, RECORD));
}
