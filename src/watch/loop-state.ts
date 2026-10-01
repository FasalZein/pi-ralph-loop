import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { lstat, open, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { parseBundleItemsJson } from "../bundle/schema.js";
import type { BundleItem } from "../bundle/types.js";
import { readStateDocument } from "../state.js";
import type { RalphLoopState } from "../types.js";
import { loadMission, MissionConfigError } from "./config.js";
import { allowsJsx, isJsTs, isTestPath, lexLines } from "./content.js";
import { parseJournal } from "./journal.js";
import { deriveTimeline } from "./timeline.js";
import { deriveHealth, type CounterBaseline } from "./health.js";
import { parseProgress, type AttemptCard } from "./progress.js";
import type {
	CommitEvent, ContentEvidence, FileChange, GitObservation, SeamEvidence, Issue, ItemStatus, LoopReader, LoopSnapshot, Mission,
	JournalRecord, JournalView, ObservedAttempt, ObservedItem, RetainedValues, RunStart, SourceName, SourceReport,
} from "./types.js";

const LOOP_FILE = ".ralph/loop.md";
const ITEMS_FILE = ".ralph/items.json";
const PROGRESS_FILE = ".ralph/progress.md";
const MISSION_FILE = ".ralph/mission.json";

const isMissing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException | null)?.code ?? "");

export type FileStamp = { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeNs: bigint };

/** A git command that ran and exited nonzero. Any other rejection is an operational failure. */
export class GitCommandError extends Error {
	readonly exitCode: number | null;
	constructor(message: string, exitCode: number | null) {
		super(message);
		this.exitCode = exitCode;
	}
}

/** The one observation boundary: clock, file reads and read-only git. Tests wrap it. */
export type ObservationRuntime = {
	now(): Date;
	stat(file: string): Promise<FileStamp | null>;
	/** Bytes [start, end) of a file; end undefined reads to the end. */
	readRange(file: string, start: number, end?: number): Promise<Buffer>;
	/**
	 * Runs `git --no-optional-locks <args>` in root with argv only. Rejects with
	 * GitCommandError on a nonzero exit.
	 */
	git(root: string, args: readonly string[], signal?: AbortSignal): Promise<string>;
};

export const defaultRuntime: ObservationRuntime = {
	now: () => new Date(),
	async stat(file) {
		try {
			const s = await stat(file, { bigint: true });
			return { dev: Number(s.dev), ino: Number(s.ino), size: Number(s.size), mtimeNs: s.mtimeNs };
		} catch (error) {
			// Only a missing path is absence; permission and I/O errors propagate.
			if (isMissing(error)) return null;
			throw error;
		}
	},
	async readRange(file, start, end) {
		const handle = await open(file, "r");
		try {
			const size = end ?? (await handle.stat()).size;
			const buffer = Buffer.alloc(Math.max(0, size - start));
			let read = 0;
			while (read < buffer.length) {
				const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read);
				if (bytesRead === 0) break;
				read += bytesRead;
			}
			return buffer.subarray(0, read);
		} finally {
			await handle.close();
		}
	},
	git(root, args, signal) {
		// Streamed output: history and diffs are not capped by a small buffer.
		return new Promise((resolve, reject) => {
			const child = spawn("git", ["--no-optional-locks", ...args], {
				cwd: root, shell: false, signal, stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			});
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			child.stdout.on("data", (c: Buffer) => out.push(c));
			child.stderr.on("data", (c: Buffer) => err.push(c));
			child.on("error", reject);
			child.on("close", (code) => {
				if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
				else reject(new GitCommandError(`git ${args[0]} exited ${code}: ${Buffer.concat(err).toString("utf8").trim()}`, code));
			});
		});
	},
};

type KeyedItem = { readonly key: string; readonly index: number; readonly item: BundleItem };

/**
 * The one result shape for every observed source. Ordinary failures are
 * values, never exceptions, and always carry their cause.
 */
export type Result<T> =
	| { readonly status: "fresh"; readonly value: T; readonly error: null }
	| { readonly status: "unavailable"; readonly value: null; readonly error: string };
const fresh = <T>(value: T): Result<T> => ({ status: "fresh", value, error: null });
const unavailable = (error: string): Result<never> => ({ status: "unavailable", value: null, error });

type HeadInfo = { readonly head: string; readonly branch: string | null; readonly base: string | null };

/** Everything derivation needs. Collected by the reader; pure input to deriveLoopSnapshot. */
export type LoopObservation = {
	readonly root: string;
	readonly observedAt: string;
	readonly mission: Mission | null;
	readonly state: Result<RalphLoopState>;
	/** Null when the task has no bundle (not applicable). */
	readonly items: Result<readonly KeyedItem[]> | null;
	readonly progress: Result<readonly AttemptCard[]> | null;
	readonly git: Result<HeadInfo>;
	readonly history: Result<readonly CommitEvent[]>;
	/** Content evidence from the git window; ignored unless git is fresh. */
	readonly evidence: ContentEvidence | null;
	readonly journal: Result<JournalView>;
	readonly counterBaseline: CounterBaseline | null;
	/** State run starts observed by this reader; fresh journal starts are merged during derivation. */
	readonly runStarts: readonly RunStart[];
	/** Committed progress cards per commit SHA, for pass commits and their first parents. */
	readonly progressAt: ReadonlyMap<string, readonly AttemptCard[] | null>;
	/** Last good values from earlier reads; shown only for sources that are not fresh. */
	readonly lastGood: RetainedValues;
	readonly issues: readonly Issue[];
};

const nonBlank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Item key: explicit nonblank id, else `index:N`. Descriptions are never keys.
 * A present id or title that is not a nonblank string is invalid, not absent.
 */
export function keyItems(items: readonly BundleItem[]): KeyedItem[] | string {
	const keyed: KeyedItem[] = [];
	for (const [index, item] of items.entries()) {
		if (item.id !== undefined && !nonBlank(item.id)) return `items[${index}].id must be a nonblank string`;
		if (item.title !== undefined && !nonBlank(item.title)) return `items[${index}].title must be a nonblank string`;
		keyed.push({ key: (item.id as string | undefined) ?? `index:${index}`, index, item });
	}
	if (new Set(keyed.map((k) => k.key)).size !== keyed.length) return "duplicate bundle item key";
	return keyed;
}

function freeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) freeze(child);
	}
	return value;
}

const RETAINED_KEY = { state: "state", items: "items", progress: "attempts", git: "git", history: "history", journal: "journal" } as const satisfies Record<SourceName, keyof RetainedValues>;

/**
 * Pure derivation: no filesystem, subprocess or clock access. Single rule:
 * only `fresh` results prove a status or feed evidence. Retained values are
 * display only.
 */
export function deriveLoopSnapshot(o: LoopObservation): LoopSnapshot {
	const issues: Issue[] = [...o.issues];
	const results: Record<SourceName, Result<unknown> | null> = { state: o.state, items: o.items, progress: o.progress, git: o.git, history: o.history, journal: o.journal };
	const sources = {} as Record<SourceName, SourceReport>;
	const retained = { state: null, items: null, attempts: null, git: null, history: null, journal: null } as { -readonly [K in keyof RetainedValues]: RetainedValues[K] };
	for (const name of Object.keys(results) as SourceName[]) {
		const r = results[name];
		const key = RETAINED_KEY[name];
		if (r === null) sources[name] = { status: "not-applicable", error: null };
		else if (r.status === "fresh") sources[name] = { status: "fresh", error: null };
		else if (o.lastGood[key]) {
			sources[name] = { status: "retained", error: r.error };
			(retained as Record<string, unknown>)[key] = o.lastGood[key];
		} else sources[name] = { status: "unavailable", error: r.error };
	}

	const state = o.state.status === "fresh" ? o.state.value : null;
	const keyed = o.items?.status === "fresh" ? o.items.value : [];
	const cards = o.progress?.status === "fresh" ? o.progress.value : [];
	const head = o.git.status === "fresh" ? o.git.value : null;
	const commits = head && o.history.status === "fresh" ? o.history.value : null;
	const keys = new Set(keyed.map((k) => k.key));
	const firstFalse = keyed.find((k) => k.item.passes !== true) ?? null;

	// Pass recency uses commit graph order, not commit timestamps.
	// A merge makes graph recency ambiguous: blocked and retry are then not asserted.
	const linear = !!commits && commits.every((c) => c.parents.length <= 1);
	if (commits && !linear) {
		issues.push({ source: "git", kind: "partial", detail: "merge commit in history; pass and blocker recency ambiguous" });
	}
	let lastPass = -1;
	commits?.forEach((c, i) => { if (c.kind === "item-pass") lastPass = i; });
	const newBlocker = (key: string): CommitEvent | null => {
		if (!commits || !linear) return null;
		let unknown: CommitEvent | null = null;
		for (let i = commits.length - 1; i > lastPass; i--) {
			if (commits[i].kind === "blocker" && commits[i].blockerItem === key) {
				// An unknown pass between this blocker and HEAD could move the boundary.
				if (!unknown) return commits[i];
				issues.push({ source: "git", kind: "partial", detail: `pass evidence unknown at ${unknown.sha}; retry and blocked cannot be proven` });
				return null;
			}
			unknown ??= commits[i].passesKnown ? null : commits[i];
		}
		return null;
	};

	let currentItem: string | null = null;
	let stoppedItem: string | null = null;
	let firstStatus: ItemStatus = "pending";
	if (firstFalse && state) {
		const blocker = newBlocker(firstFalse.key);
		if (!commits) {
			const cause = o.git.status !== "fresh" ? o.git.error : o.history.error;
			issues.push({ source: "git", kind: "unavailable", detail: `blocker history unavailable (${cause}); retry and blocked cannot be proven` });
		}
		if (state.running) {
			currentItem = firstFalse.key;
			firstStatus = blocker ? "retry" : "working";
		} else {
			stoppedItem = firstFalse.key;
			const start = Date.parse(state.started_at);
			const at = blocker?.committedAt == null ? Number.NaN : Date.parse(blocker.committedAt);
			if (blocker && !(Number.isFinite(start) && Number.isFinite(at))) {
				issues.push({ source: Number.isFinite(start) ? "git" : "state", kind: "partial", detail: "blocker or run start time is invalid; blocked cannot be proven" });
			}
			// Strictly newer than the run start: equality is not newer.
			firstStatus = blocker && Number.isFinite(start) && at > start ? "blocked" : "stopped";
		}
	} else if (firstFalse) {
		issues.push({ source: "state", kind: "unavailable", detail: `loop state not fresh (${o.state.error}); item activity unknown` });
	}

	const items: ObservedItem[] = keyed.map(({ key, index, item }) => ({
		key, index,
		id: nonBlank(item.id) ? item.id : null,
		title: itemTitle(item, key, o.mission),
		description: item.description,
		passes: item.passes === true,
		regressionNotes: item.regression_notes,
		status: item.passes === true ? "passed" : key === firstFalse?.key ? firstStatus : "pending",
	}));

	const commitFor = new Map<number, string | null>();
	for (const card of cards) {
		if (card.outcome !== "passed" || card.id === null || !keys.has(card.id)) continue;
		const found = passCommit(card, cards, commits, o.progressAt);
		if (found.issue) issues.push({ source: "progress", kind: "partial", detail: found.issue });
		commitFor.set(card.index, found.sha);
	}
	const attempts: ObservedAttempt[] = cards.map((card) => ({
		...card,
		commitSha: commitFor.get(card.index) ?? null,
		resolvedCommitSha: card.resolvedBy === null ? null : commitFor.get(card.resolvedBy) ?? null,
	}));
	// Null prototype: item keys such as `__proto__` become own entries.
	const itemAttempts: Record<string, ObservedAttempt[]> = Object.create(null);
	for (const key of keys) {
		const own = attempts.filter((a) => a.id === key);
		const open = own.filter((a) => a.outcome === "blocked" && a.resolvedBy === null).reverse();
		const rest = own.filter((a) => !open.includes(a)).reverse();
		itemAttempts[key] = [...open, ...rest];
	}

	const journal = o.journal.status === "fresh" ? o.journal.value : null;
	const starts = new Map((journal?.runs ?? []).map((r) => [JSON.stringify([r.loopToken, r.startedAt]), r]));
	for (const r of o.runStarts) {
		const key = JSON.stringify([r.loopToken, r.startedAt]);
		if (!starts.has(key)) starts.set(key, r);
	}
	const mergedStarts = [...starts.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
	const launchId = state ? [...(journal?.records ?? [])].reverse().find((r) => r.k === "loop" && r.tok === state.loop_token)?.r
		?? [...(journal?.launches ?? [])].reverse().find((r) => Date.parse(r.at) > Date.parse(state.started_at))?.launchId ?? null : null;
	const timing = deriveTimeline({ commits, runs: mergedStarts, journal, state, items, item: currentItem ?? stoppedItem, now: o.observedAt });
	issues.push(...timing.issues);
	const health = deriveHealth(state, o.issues.some((i) => i.source === "state" && i.kind === "missing"), journal, Date.parse(o.observedAt), o.counterBaseline, launchId);
	return freeze({
		root: o.root,
		observedAt: o.observedAt,
		mission: o.mission,
		task: o.mission?.task.kind ?? (state ? (state.bundle_mode ? "bundle" : "plain") : null),
		run: { launchId, loopToken: state?.loop_token ?? null, startedAt: state?.started_at ?? null },
		state,
		items, currentItem, stoppedItem, attempts, itemAttempts,
		runStarts: mergedStarts,
		historyComplete: timing.timeline.coverage.complete,
		timeline: timing.timeline, health,
		git: head ? { ...head, commits } : null,
		evidence: head ? o.evidence : null,
		sources,
		retained,
		issues,
	} satisfies LoopSnapshot);
}

function itemTitle(item: BundleItem, key: string, mission: Mission | null): string {
	if (nonBlank(item.title)) return item.title;
	const scoped = mission?.scope.items.find((s) => s.id === key)?.title;
	return scoped ?? item.description;
}

/**
 * The single item-pass commit that flips this card's item, holds this entry at
 * its index, and whose first parent holds no identical entry at any index.
 * Moved, copied, duplicated or pre-existing entries give null plus an issue.
 */
function passCommit(
	card: AttemptCard,
	cards: readonly AttemptCard[],
	commits: readonly CommitEvent[] | null,
	progressAt: ReadonlyMap<string, readonly AttemptCard[] | null>,
): { sha: string | null; issue: string | null } {
	const same = (c: AttemptCard | undefined) => !!c && c.outcome === "passed" && c.id === card.id && c.raw.trimEnd() === card.raw.trimEnd();
	const candidates = (commits ?? []).filter((c) => c.passedItems.includes(card.id!) && same(progressAt.get(c.sha)?.[card.index]));
	if (!candidates.length) return { sha: null, issue: null };
	const introduced = candidates.filter((c) => c.parents[0] !== undefined && progressAt.has(c.parents[0]) && !(progressAt.get(c.parents[0]) ?? []).some(same));
	const unique = cards.filter(same).length === 1;
	if (unique && introduced.length === 1 && candidates.length === 1) return { sha: introduced[0].sha, issue: null };
	return { sha: null, issue: `progress entry ${card.index} (${card.id}) was not introduced by exactly one pass commit; commit SHA unavailable` };
}

/** Items at a commit: absent file, invalid content, or a pass map. */
type ItemsAt = { readonly kind: "absent" } | { readonly kind: "invalid"; readonly reason: string } | { readonly kind: "ok"; readonly passes: ReadonlyMap<string, boolean> };

type CommitFacts = {
	readonly parents: readonly string[];
	readonly subject: string;
	readonly committedAt: string;
	readonly items: ItemsAt;
	readonly progressBlob: string | null;
};

type ProgressCache = { stamp: FileStamp; bytes: number; prefixHash: string; cards: readonly AttemptCard[] };

function sameFile(a: FileStamp | null, b: FileStamp | null): boolean {
	if (a === null || b === null) return a === b;
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Sourced<T> = { readonly result: Result<T>; readonly stamp: FileStamp | null };

/**
 * Open a serialized reader for one loop root. Invalid root or mismatched mission
 * throws; ordinary observation failures become snapshot issues.
 */
export function openLoop(inputRoot: string, opts: { mission?: Mission; runtime?: ObservationRuntime } = {}): LoopReader {
	const root = realpathSync(inputRoot);
	if (!statSync(root).isDirectory()) throw new Error(`Not a directory: ${inputRoot}`);
	if (opts.mission && opts.mission.root !== root) throw new Error("mission root does not match loop root");
	const rt = opts.runtime ?? defaultRuntime;
	const file = (rel: string) => path.join(root, rel);

	let mission: Mission | null = opts.mission ?? null;
	let stateCache: { stamp: FileStamp; result: Result<RalphLoopState> } | null = null;
	let itemsCache: { stamp: FileStamp; result: Result<readonly KeyedItem[]> } | null = null;
	let progress: ProgressCache | null = null;
	// Immutable git facts, cached only after a successful read.
	const commitCache = new Map<string, CommitFacts>();
	const blobCards = new Map<string, readonly AttemptCard[]>();
	const contentHashes = new Map<string, { stamp: FileStamp; hash: string }>();
	// Bytes read in this observation, shared by the worktree fingerprint and the progress parser.
	let observed = new Map<string, { stamp: FileStamp; bytes: Buffer }>();
	const runStarts: RunStart[] = [];
	const lastGood: { -readonly [K in keyof RetainedValues]: RetainedValues[K] } = { state: null, items: null, attempts: null, git: null, history: null, journal: null };
	let counterBaseline: CounterBaseline | null = null;
	type JournalCache = { stamp: FileStamp; offset: number; carry: Buffer; records: JournalRecord[]; badLines: number; prefixHash: string };
	let journalLive: JournalCache | null = null;
	let journalRotated: JournalCache | null = null;
	let queue: Promise<unknown> = Promise.resolve();
	let closed = false;
	let active: AbortController | null = null;

	async function readMission(issues: Issue[]): Promise<void> {
		if (mission) return;
		if (!existsSync(file(MISSION_FILE))) {
			issues.push({ source: "mission", kind: "missing", detail: "no mission.json; no policy, base or control" });
			return;
		}
		try {
			mission = await loadMission(root);
		} catch (error) {
			if (!(error instanceof MissionConfigError)) throw error;
			issues.push({ source: "mission", kind: "partial", detail: error.message });
		}
	}

	/** Run a source reader; an exception becomes an unavailable result with its cause. */
	async function guarded<T>(source: SourceName, signal: AbortSignal, read: () => Promise<Sourced<T>>, issues: Issue[]): Promise<Sourced<T>> {
		try {
			return await read();
		} catch (error) {
			if (signal.aborted) throw error;
			issues.push({ source, kind: "unavailable", detail: message(error) });
			return { result: unavailable(message(error)), stamp: null };
		}
	}

	/** Whole-file bytes for a stamp, read at most once per observation. */
	async function fileBytes(full: string, stamp: FileStamp): Promise<Buffer> {
		const seen = observed.get(full);
		if (seen && sameFile(seen.stamp, stamp)) return seen.bytes;
		const bytes = await rt.readRange(full, 0, stamp.size);
		observed.set(full, { stamp, bytes });
		return bytes;
	}

	async function missing<T>(source: SourceName, rel: string, issues: Issue[]): Promise<Sourced<T>> {
		issues.push({ source, kind: "missing", detail: `${rel} not found` });
		return { result: unavailable(`${rel} not found`), stamp: null };
	}

	async function readStateFile(issues: Issue[]): Promise<Sourced<RalphLoopState>> {
		const stamp = await rt.stat(file(LOOP_FILE));
		if (!stamp) { stateCache = null; return missing("state", LOOP_FILE, issues); }
		if (!stateCache || !sameFile(stateCache.stamp, stamp)) {
			const doc = readStateDocument(root);
			if (!sameFile(stamp, await rt.stat(file(LOOP_FILE)))) {
				stateCache = null;
				issues.push({ source: "state", kind: "concurrent", detail: `${LOOP_FILE} changed during read` });
				return { result: unavailable(`${LOOP_FILE} changed during read`), stamp };
			}
			const result = doc.status === "valid" ? fresh(doc.state) : unavailable(doc.status === "partial" ? doc.reason : `${LOOP_FILE} not found`);
			// Read errors are operational: never cached.
			stateCache = doc.status === "partial" && doc.reason.startsWith("read error:") ? null : { stamp, result };
			if (!stateCache) { issues.push({ source: "state", kind: "unavailable", detail: result.error! }); return { result, stamp }; }
		}
		if (stateCache.result.status !== "fresh") issues.push({ source: "state", kind: "partial", detail: stateCache.result.error });
		return { result: stateCache.result, stamp };
	}

	async function readItems(issues: Issue[]): Promise<Sourced<readonly KeyedItem[]>> {
		const stamp = await rt.stat(file(ITEMS_FILE));
		if (!stamp) { itemsCache = null; return missing("items", ITEMS_FILE, issues); }
		if (!itemsCache || !sameFile(itemsCache.stamp, stamp)) {
			// A read failure throws to `guarded` and is not cached; parse failures are content facts.
			const text = (await rt.readRange(file(ITEMS_FILE), 0)).toString("utf8");
			if (!sameFile(stamp, await rt.stat(file(ITEMS_FILE)))) {
				itemsCache = null;
				issues.push({ source: "items", kind: "concurrent", detail: `${ITEMS_FILE} changed during read` });
				return { result: unavailable(`${ITEMS_FILE} changed during read`), stamp };
			}
			let keyed: KeyedItem[] | string;
			try {
				keyed = keyItems(parseBundleItemsJson(text).items);
			} catch (error) {
				keyed = message(error);
			}
			itemsCache = { stamp, result: typeof keyed === "string" ? unavailable(keyed) : fresh(keyed) };
		}
		if (itemsCache.result.status !== "fresh") issues.push({ source: "items", kind: "partial", detail: itemsCache.result.error });
		return { result: itemsCache.result, stamp };
	}

	/**
	 * Unchanged files are not read. A changed file is read in full once per
	 * observation; the cached prefix hash must still match, so an edit anywhere
	 * in old content is detected and reparsed with an issue.
	 */
	async function readProgress(issues: Issue[]): Promise<Sourced<readonly AttemptCard[]>> {
		const stamp = await rt.stat(file(PROGRESS_FILE));
		if (!stamp) { progress = null; return missing("progress", PROGRESS_FILE, issues); }
		if (progress && sameFile(progress.stamp, stamp)) return { result: fresh(progress.cards), stamp };
		const bytes = await fileBytes(file(PROGRESS_FILE), stamp);
		if (!sameFile(stamp, await rt.stat(file(PROGRESS_FILE)))) {
			issues.push({ source: "progress", kind: "concurrent", detail: `${PROGRESS_FILE} changed during read` });
			return { result: unavailable(`${PROGRESS_FILE} changed during read`), stamp };
		}
		if (progress && (bytes.length < progress.bytes || sha256(bytes.subarray(0, progress.bytes)) !== progress.prefixHash)) {
			issues.push({ source: "progress", kind: "partial", detail: `${PROGRESS_FILE} was edited, not appended; reparsed` });
		}
		// The decoder withholds an incomplete trailing UTF-8 sequence until the append completes.
		const text = new StringDecoder("utf8").write(bytes);
		progress = { stamp, bytes: bytes.length, prefixHash: sha256(bytes), cards: parseProgress(text) };
		return { result: fresh(progress.cards), stamp };
	}

	const identity = (a: FileStamp | null, b: FileStamp | null) => a === null || b === null ? a === b : a.dev === b.dev && a.ino === b.ino;
	async function journalFile(rel: string, stamp: FileStamp | null, cache: JournalCache | null, final: boolean, issues: Issue[]): Promise<JournalCache | null> {
		if (!stamp) return null;
		if (cache && identity(cache.stamp, stamp) && sameFile(cache.stamp, stamp)) return cache;
		let prefix: Buffer | null = null;
		if (cache && identity(cache.stamp, stamp)) {
			// Checking the old prefix is necessary to distinguish an append from a rewrite plus append.
			prefix = stamp.size >= cache.offset ? await rt.readRange(file(rel), 0, cache.offset) : null;
			if (stamp.size < cache.offset || !prefix || sha256(prefix) !== cache.prefixHash) {
				issues.push({ source: "journal", kind: "partial", detail: "journal truncated or rewritten; reparsed" });
				cache = null;
			}
		} else cache = null;
		const offset = cache?.offset ?? 0;
		const bytes = await rt.readRange(file(rel), offset, stamp.size);
		if (bytes.length !== stamp.size - offset) throw new Error("short journal read");
		const joined = Buffer.concat([cache?.carry ?? Buffer.alloc(0), bytes]);
		const newline = joined.lastIndexOf(10);
		const complete = joined.subarray(0, newline + 1);
		const carry = joined.subarray(newline + 1);
		const parsed = parseJournal(new StringDecoder("utf8").write(complete));
		// Invalid timestamps cannot be timing evidence even when the wire shape is valid.
		const records = parsed.records.filter((r) => Number.isFinite(Date.parse(r.t)) && (r.k !== "loop" || Number.isFinite(Date.parse(r.sa))));
		return { stamp, offset: stamp.size, carry: final ? Buffer.alloc(0) : carry,
			records: [...(cache?.records ?? []), ...records],
			badLines: (cache?.badLines ?? 0) + parsed.badLines + parsed.records.length - records.length + (final && carry.length ? 1 : 0),
			prefixHash: sha256(Buffer.concat([cache && prefix ? prefix : Buffer.alloc(0), bytes])),
		};
	}
	async function readJournalSource(issues: Issue[]): Promise<Sourced<JournalView>> {
		const live = await rt.stat(file(".ralph/journal.jsonl"));
		const rotated = await rt.stat(file(".ralph/journal.1.jsonl"));
		if (!live && !rotated) { journalLive = null; journalRotated = null; return missing("journal", ".ralph/journal.jsonl", issues); }
		if (journalLive && !identity(journalLive.stamp, live)) {
			if (rotated && identity(journalLive.stamp, rotated)) journalRotated = journalLive;
			else {
				journalRotated = null;
				issues.push({ source: "journal", kind: "partial", detail: "rotation not followed; reparsed" });
			}
			journalLive = null;
		}
		journalRotated = await journalFile(".ralph/journal.1.jsonl", rotated, journalRotated, true, issues);
		// Finalize a trailing partial line in an unchanged former live file.
		if (journalRotated?.carry.length) journalRotated = { ...journalRotated, carry: Buffer.alloc(0), badLines: journalRotated.badLines + 1 };
		journalLive = await journalFile(".ralph/journal.jsonl", live, journalLive, false, issues);
		const headers = new Set<string>();
		const records = [...(journalRotated?.records ?? []), ...(journalLive?.records ?? [])].filter((r) => {
			if (r.k !== "run") return true;
			const key = JSON.stringify([r.r, r.t]);
			if (headers.has(key)) return false;
			headers.add(key); return true;
		});
		const badLines = (journalRotated?.badLines ?? 0) + (journalLive?.badLines ?? 0);
		if (badLines) issues.push({ source: "journal", kind: "partial", detail: `${badLines} invalid journal lines` });
		const launches = records.flatMap((r) => r.k === "run" ? [{ launchId: r.r, at: r.t }] : []);
		const runs: RunStart[] = records.flatMap((r) => r.k === "loop" ? [{ source: "journal" as const, loopToken: r.tok, startedAt: r.sa }] : []);
		const stops: JournalView["stops"] = records.flatMap((r) => r.k === "d" && (r.e === "exit" || r.e === "pi-exit") ? [{ at: r.t, launchId: r.r, kind: r.e }] : []);
		return { stamp: live, result: fresh(freeze({ records, launches, runs, stops, badLines, rotated: rotated !== null, coverageStart: records[0]?.t ?? null })) };
	}

	/**
	 * HEAD, branch, index bytes and the content and mode of every modified,
	 * deleted or untracked nonignored path. Any failure except the detached-HEAD
	 * exit and a missing path throws.
	 */
	async function gitStamp(signal: AbortSignal): Promise<{ head: string; branch: string | null; digest: string }> {
		const head = (await rt.git(root, ["rev-parse", "--verify", "HEAD"], signal)).trim();
		let branch: string | null;
		try {
			branch = (await rt.git(root, ["symbolic-ref", "-q", "--short", "HEAD"], signal)).trim();
		} catch (error) {
			// `symbolic-ref -q` exits 1 only when HEAD is detached.
			if (!(error instanceof GitCommandError && error.exitCode === 1)) throw error;
			branch = null;
		}
		const indexPath = path.resolve(root, (await rt.git(root, ["rev-parse", "--git-path", "index"], signal)).trim());
		const indexStamp = await rt.stat(indexPath);
		// The index version is part of the stamp: a staged A-to-B-to-A edit in the window is a change.
		const index = indexStamp ? [sha256(await rt.readRange(indexPath, 0)), indexStamp.ino, indexStamp.size, String(indexStamp.mtimeNs)] : "absent";
		const dirty = [...new Set((await rt.git(root, ["ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard"], signal)).split("\0").filter((p) => !!p && p !== ".ralph/journal.jsonl" && p !== ".ralph/journal.1.jsonl"))].sort();
		const content: string[] = [];
		for (const rel of dirty) {
			const full = path.join(root, rel);
			const info = await lstat(full).catch((error: unknown) => {
				if (isMissing(error)) return null;
				throw error;
			});
			if (!info) content.push(`${rel}\0deleted`);
			else if (info.isSymbolicLink()) content.push(`${rel}\0link\0${await readlink(full)}`);
			else if (info.isFile()) content.push(`${rel}\0${info.mode}\0${await contentHash(full)}`);
			else content.push(`${rel}\0${info.mode}`);
		}
		return { head, branch, digest: sha256(JSON.stringify([head, branch, index, content])) };
	}

	/** Content hash, reused while the file stamp is unchanged so unchanged dirty files are not reread. */
	async function contentHash(full: string): Promise<string> {
		const stamp = await rt.stat(full);
		if (!stamp) return "deleted";
		const cached = contentHashes.get(full);
		if (cached && sameFile(cached.stamp, stamp)) return cached.hash;
		const hash = sha256(await fileBytes(full, stamp));
		if (sameFile(stamp, await rt.stat(full))) contentHashes.set(full, { stamp, hash });
		return hash;
	}

	async function blob(oid: string, signal: AbortSignal): Promise<string> {
		return rt.git(root, ["cat-file", "blob", oid], signal);
	}

	/** Operational failures throw and are never cached. */
	async function commitFacts(sha: string, signal: AbortSignal): Promise<CommitFacts> {
		const cached = commitCache.get(sha);
		if (cached) return cached;
		const [committedAt, subject, parentList] = (await rt.git(root, ["show", "-s", "--format=%cI%x00%s%x00%P", sha], signal)).replace(/\n$/, "").split("\0");
		const blobs = new Map<string, string>();
		for (const entry of (await rt.git(root, ["ls-tree", "-z", sha, "--", ITEMS_FILE, PROGRESS_FILE], signal)).split("\0").filter(Boolean)) {
			const tab = entry.indexOf("\t");
			blobs.set(entry.slice(tab + 1), entry.slice(0, tab).split(" ")[2]);
		}
		let items: ItemsAt = { kind: "absent" };
		const itemsBlob = blobs.get(ITEMS_FILE);
		if (itemsBlob) {
			const text = await blob(itemsBlob, signal);
			try {
				const keyed = keyItems(parseBundleItemsJson(text).items);
				items = typeof keyed === "string" ? { kind: "invalid", reason: keyed } : { kind: "ok", passes: new Map(keyed.map((k) => [k.key, k.item.passes === true])) };
			} catch (error) {
				items = { kind: "invalid", reason: message(error) };
			}
		}
		const facts = { committedAt, subject, parents: (parentList ?? "").split(" ").filter(Boolean), items, progressBlob: blobs.get(PROGRESS_FILE) ?? null };
		commitCache.set(sha, facts);
		return facts;
	}

	async function progressAt(sha: string, signal: AbortSignal): Promise<readonly AttemptCard[] | null> {
		const oid = (await commitFacts(sha, signal)).progressBlob;
		if (oid === null) return null;
		if (!blobCards.has(oid)) blobCards.set(oid, parseProgress(await blob(oid, signal)));
		return blobCards.get(oid)!;
	}

	async function readHistory(issues: Issue[], signal: AbortSignal, progressOut: Map<string, readonly AttemptCard[] | null>, head: string, ancestry: { baseAncestor: boolean | null }): Promise<Result<readonly CommitEvent[]>> {
		const base = mission?.git.baseCommit ?? null;
		if (base === null) {
			issues.push({ source: "git", kind: "unavailable", detail: "no mission base; commit history unavailable" });
			return unavailable("no mission base");
		}
		try {
			try {
				await rt.git(root, ["merge-base", "--is-ancestor", base, head], signal);
				ancestry.baseAncestor = true;
			} catch (error) {
				// Exit 1 proves non-ancestry; anything else is unknown, not a history fact.
				if (!(error instanceof GitCommandError && error.exitCode === 1)) throw error;
				ancestry.baseAncestor = false;
				const detail = `base ${base} is not an ancestor of HEAD; history incomplete`;
				issues.push({ source: "git", kind: "partial", detail });
				return unavailable(detail);
			}
			const list = (await rt.git(root, ["rev-list", "--reverse", "--topo-order", `${base}..${head}`], signal)).split("\n").filter(Boolean);
			const commits: CommitEvent[] = [];
			for (const sha of list) {
				const facts = await commitFacts(sha, signal);
				const parent = facts.parents[0] ? await commitFacts(facts.parents[0], signal) : null;
				for (const [at, f] of [[sha, facts], [facts.parents[0], parent]] as const) {
					if (f?.items.kind === "invalid") issues.push({ source: "git", kind: "partial", detail: `${ITEMS_FILE} invalid at ${at}: ${f.items.reason}; passes there unknown` });
				}
				const event = classify(sha, facts, parent, mission!);
				if (event.committedAt === null) issues.push({ source: "git", kind: "partial", detail: `invalid committer timestamp at ${sha}` });
				commits.push(event);
				if (event.kind === "item-pass") {
					progressOut.set(sha, await progressAt(sha, signal));
					if (facts.parents[0]) progressOut.set(facts.parents[0], await progressAt(facts.parents[0], signal));
				}
			}
			return fresh(commits);
		} catch (error) {
			if (signal.aborted) throw error;
			const detail = `history unavailable: ${message(error)}`;
			issues.push({ source: "git", kind: "unavailable", detail });
			return unavailable(detail);
		}
	}

	/** Base flags for every content diff: no external diff, textconv, colour or rename pairing. */
	const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
	// Unified context that carries the whole new file: lexing and calls that span lines need every line.
	const WHOLE_FILE_CONTEXT = "-U2147483647";
	let emptyTree: string | null = null;
	const STATUSES = new Set(["A", "M", "D", "T", "U"]);

	/** Generic rules read content of JS/TS files and discovered tests only. */
	const scanned = (rel: string) => isJsTs(rel) || isTestPath(mission, rel);

	/** New-side content of one path from a single-path whole-file diff. */
	async function diffContent(range: readonly string[], rel: string, signal: AbortSignal): Promise<FileChange["content"]> {
		const diff = () => rt.git(root, ["--literal-pathspecs", "diff", WHOLE_FILE_CONTEXT, ...DIFF, ...range, "--", rel], signal);
		// An empty range compares the index with the live worktree file.
		const out = range.length === 0 ? await liveRead(path.join(root, rel), diff) : await diff();
		return parseDiff(rel, out);
	}

	/** Hunk headers carry the new-side line numbers; context and added rows give every new-side line. */
	function parseDiff(rel: string, out: string): FileChange["content"] {
		const rows = out.split("\n");
		const added: number[] = [];
		const lines: string[] = [];
		let hunk = false;
		let seenHunk = false;
		let n = 0;
		for (const row of rows) {
			const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
			if (header) { hunk = seenHunk = true; n = Number(header[1]); continue; }
			if (!hunk) continue;
			if (row.startsWith("+")) { added.push(n); lines[n - 1] = row.slice(1); n++; }
			else if (row.startsWith(" ")) { lines[n - 1] = row.slice(1); n++; }
			else if (!row.startsWith("-") && !row.startsWith("\\")) hunk = false;
		}
		if (!seenHunk && rows.some((row) => row.startsWith("Binary files ") || row === "GIT binary patch")) return { kind: "unavailable", reason: "binary" };
		return textContent(rel, lines, added);
	}

	function textContent(rel: string, sparse: readonly string[], added: readonly number[]): FileChange["content"] {
		const lines = Array.from(sparse, (line) => line ?? "");
		return { kind: "lines", lines, added, lexed: isJsTs(rel) ? lexLines(lines.join("\n"), allowsJsx(rel)) : null };
	}

	async function seam(range: readonly string[], signal: AbortSignal): Promise<FileChange[]> {
		const parts = (await rt.git(root, ["diff", "--name-status", "-z", ...DIFF, ...range], signal)).split("\0");
		const changes: FileChange[] = [];
		for (let i = 0; i + 1 < parts.length; i += 2) {
			const [status, rel] = [parts[i], parts[i + 1]];
			if (!STATUSES.has(status)) throw new Error(`unexpected diff status ${JSON.stringify(status)} for ${JSON.stringify(rel)}`);
			const content: FileChange["content"] = status === "D" || !scanned(rel) ? { kind: "skipped" }
				: status === "U" ? { kind: "unavailable", reason: "unmerged" }
				: await diffContent(range, rel, signal);
			changes.push({ path: rel, status: status as FileChange["status"], content });
		}
		return changes;
	}

	/** Untracked, nonignored files are additions in the worktree seam. */
	async function untracked(signal: AbortSignal): Promise<FileChange[]> {
		const paths = (await rt.git(root, ["ls-files", "-z", "--others", "--exclude-standard"], signal)).split("\0")
			.filter((p) => !!p && p !== ".ralph/journal.jsonl" && p !== ".ralph/journal.1.jsonl");
		const changes: FileChange[] = [];
		for (const rel of paths) {
			if (!scanned(rel)) { changes.push({ path: rel, status: "A", content: { kind: "skipped" } }); continue; }
			const full = path.join(root, rel);
			const info = await lstat(full);
			if (!info.isFile()) { changes.push({ path: rel, status: "A", content: { kind: "unavailable", reason: "not a regular file" } }); continue; }
			const bytes = await liveRead(full, () => rt.readRange(full, 0));
			// Git's own heuristic: a NUL in the first 8000 bytes means binary.
			if (bytes.subarray(0, 8000).includes(0)) { changes.push({ path: rel, status: "A", content: { kind: "unavailable", reason: "binary" } }); continue; }
			const text = bytes.toString("utf8");
			const rows = text.split("\n");
			if (text.endsWith("\n")) rows.pop();
			changes.push({ path: rel, status: "A", content: textContent(rel, rows, rows.map((_, i) => i + 1)) });
		}
		return changes;
	}

	/**
	 * Version of every live worktree file whose content became evidence. The
	 * content-hash stamp cannot see an A-to-B-to-A edit, so each live read is
	 * bracketed by file stamps and rechecked at the end of the window.
	 */
	let liveReads = new Map<string, FileStamp | null>();
	let liveRaced = false;
	async function liveRead<T>(full: string, read: () => Promise<T>): Promise<T> {
		const before = await rt.stat(full);
		const value = await read();
		if (!sameFile(before, await rt.stat(full))) liveRaced = true;
		const seen = liveReads.get(full);
		if (seen !== undefined && !sameFile(seen, before)) liveRaced = true;
		liveReads.set(full, before);
		return value;
	}
	/** True when a live content read raced a write, or a file changed after it was read. */
	async function liveEvidenceChanged(): Promise<boolean> {
		if (liveRaced) return true;
		for (const [full, stamp] of liveReads) if (!sameFile(stamp, await rt.stat(full))) return true;
		return false;
	}

	const commitEvidence = new Map<string, SeamEvidence>();
	async function readEvidence(history: Result<readonly CommitEvent[]>, baseAncestor: boolean | null, signal: AbortSignal): Promise<ContentEvidence> {
		liveReads = new Map();
		liveRaced = false;
		const attempt = async (read: () => Promise<FileChange[]>): Promise<SeamEvidence> => {
			try {
				return { status: "fresh", changes: await read() };
			} catch (error) {
				if (signal.aborted) throw error;
				return { status: "unavailable", error: message(error) };
			}
		};
		const commits: Record<string, SeamEvidence> = Object.create(null);
		for (const c of history.status === "fresh" ? history.value : []) {
			let found = commitEvidence.get(c.sha);
			if (!found) {
				found = await attempt(async () => {
					emptyTree ??= (await rt.git(root, ["hash-object", "-t", "tree", "/dev/null"], signal)).trim();
					return seam([c.parents[0] ?? emptyTree, c.sha], signal);
				});
				// Commits are immutable: cache evidence, never a failure.
				if (found.status === "fresh") commitEvidence.set(c.sha, found);
			}
			commits[c.sha] = found;
		}
		const index = await attempt(() => seam(["--cached", "HEAD"], signal));
		const worktree = await attempt(async () => [...await seam([], signal), ...await untracked(signal)]);
		return { baseAncestor, commits, index, worktree };
	}

	async function observe(signal: AbortSignal): Promise<LoopSnapshot> {
		const issues: Issue[] = [];
		const observedAt = rt.now().toISOString();
		observed = new Map();
		const failed = (error: string): LoopObservation => ({
			root, observedAt, mission, state: unavailable(error), items: unavailable(error), progress: unavailable(error),
			git: unavailable(error), history: unavailable(error), evidence: null, journal: unavailable(error), counterBaseline, runStarts, progressAt: new Map(), lastGood, issues,
		});
		try {
			signal.throwIfAborted();
			await readMission(issues);
			// The git window opens before any source read, so it covers the whole observation.
			let git: Result<HeadInfo>;
			let before: Awaited<ReturnType<typeof gitStamp>> | null = null;
			try {
				before = await gitStamp(signal);
				git = fresh({ head: before.head, branch: before.branch, base: mission?.git.baseCommit ?? null });
			} catch (error) {
				if (signal.aborted) throw error;
				issues.push({ source: "git", kind: "unavailable", detail: message(error) });
				git = unavailable(message(error));
			}
			const journalRead = await guarded("journal", signal, () => readJournalSource(issues), issues);
			const state = await guarded("state", signal, () => readStateFile(issues), issues);
			const bundle = mission ? mission.task.kind === "bundle" : state.result.status === "fresh" ? state.result.value.bundle_mode : existsSync(file(ITEMS_FILE));
			const items = bundle ? await guarded("items", signal, () => readItems(issues), issues) : null;
			const cards = bundle ? await guarded("progress", signal, () => readProgress(issues), issues) : null;
			const progressAtPass = new Map<string, readonly AttemptCard[] | null>();
			let history: Result<readonly CommitEvent[]> = unavailable(git.error ?? "git unavailable");
			let evidence: ContentEvidence | null = null;
			if (before) {
				const ancestry = { baseAncestor: null as boolean | null };
				history = await readHistory(issues, signal, progressAtPass, before.head, ancestry);
				// Content is read inside the window, so a change during the read is a retry, never a finding.
				evidence = await readEvidence(history, ancestry.baseAncestor, signal);
				let after: typeof before | null = null;
				try {
					after = await gitStamp(signal);
				} catch (error) {
					if (signal.aborted) throw error;
					// An inspection failure is not evidence of change: keep its cause.
					const detail = `second git inspection failed: ${message(error)}`;
					issues.push({ source: "git", kind: "unavailable", detail });
					git = unavailable(detail);
				}
				let changed = !!after && after.digest !== before.digest;
				if (after && !changed) {
					try {
						changed = await liveEvidenceChanged();
					} catch (error) {
						if (signal.aborted) throw error;
						const detail = `live evidence recheck failed: ${message(error)}`;
						issues.push({ source: "git", kind: "unavailable", detail });
						git = unavailable(detail);
					}
				}
				if (changed) {
					// No tight retry loop: the next read retries and publishes one coherent result.
					const detail = "HEAD, index or worktree changed during read; retry next poll";
					issues.push({ source: "git", kind: "concurrent", detail });
					git = unavailable(detail);
				}
				// History from an inconsistent window is not fresh.
				if (git.status !== "fresh" && history.status === "fresh") history = unavailable(git.error);
			}
			signal.throwIfAborted();
			// Every fresh file source must be unchanged from its read to the end of the observation.
			const recheck = async <T>(name: SourceName, rel: string, read: Sourced<T> | null): Promise<Result<T> | null> => {
				if (!read || read.result.status !== "fresh") return read?.result ?? null;
				try {
					if (sameFile(read.stamp, await rt.stat(file(rel)))) return read.result;
					issues.push({ source: name, kind: "concurrent", detail: `${rel} changed during observation; retry next poll` });
					return unavailable(`${rel} changed during observation`);
				} catch (error) {
					issues.push({ source: name, kind: "unavailable", detail: message(error) });
					return unavailable(message(error));
				}
			};
			let journalResult = journalRead.result;
			if (journalResult.status === "fresh") {
				try {
					if (!identity(journalRead.stamp, await rt.stat(file(".ralph/journal.jsonl")))) {
						issues.push({ source: "journal", kind: "concurrent", detail: "journal rotated during observation" });
						journalResult = unavailable("journal rotated during observation");
					}
				} catch (error) { journalResult = unavailable(message(error)); issues.push({ source: "journal", kind: "unavailable", detail: message(error) }); }
			}
			const stateResult = (await recheck("state", LOOP_FILE, state))!;
			const itemsResult = await recheck("items", ITEMS_FILE, items);
			const progressResult = await recheck("progress", PROGRESS_FILE, cards);
			if (stateResult.status === "fresh") {
				const s = stateResult.value;
				if (!Number.isFinite(Date.parse(s.started_at))) {
					issues.push({ source: "state", kind: "partial", detail: "started_at is not a valid time; no run boundary" });
				} else if (!runStarts.some((r) => r.loopToken === s.loop_token && r.startedAt === s.started_at)) {
					runStarts.push({ source: "state", loopToken: s.loop_token, startedAt: s.started_at });
				}
			}
			const snapshot = deriveLoopSnapshot({
				root, observedAt, mission, state: stateResult, items: itemsResult, progress: progressResult,
				git, history, evidence, journal: journalResult, counterBaseline, runStarts, progressAt: progressAtPass, lastGood, issues,
			});
			if (journalResult.status === "fresh") lastGood.journal = { value: journalResult.value, observedAt };
			if (stateResult.status === "fresh") {
				const s = stateResult.value;
				counterBaseline = { launchId: snapshot.run.launchId, loopToken: s.loop_token, startedAt: s.started_at, errors: s.error_count, bundleRejections: s.bundle_rejection_count };
			}
			remember(snapshot);
			return snapshot;
		} catch (error) {
			const detail = signal.aborted ? "read aborted" : message(error);
			issues.push({ source: "observer", kind: "unavailable", detail });
			return deriveLoopSnapshot(failed(detail));
		} finally {
			observed = new Map();
		}
	}

	/** Only fresh values become last-good; a failure never advances observedAt. */
	function remember(s: LoopSnapshot): void {
		const at = s.observedAt;
		if (s.sources.state.status === "fresh" && s.state) lastGood.state = { value: s.state, observedAt: at };
		if (s.sources.items.status === "fresh") lastGood.items = { value: s.items, observedAt: at };
		if (s.sources.progress.status === "fresh") lastGood.attempts = { value: s.attempts, observedAt: at };
		if (s.sources.git.status === "fresh" && s.git) lastGood.git = { value: s.git, observedAt: at };
		if (s.sources.history.status === "fresh" && s.git?.commits) lastGood.history = { value: s.git.commits, observedAt: at };
	}

	return {
		read(signal?: AbortSignal): Promise<LoopSnapshot> {
			const run = async (): Promise<LoopSnapshot> => {
				if (closed) {
					const error = unavailable("reader closed");
					return deriveLoopSnapshot({
						root, observedAt: rt.now().toISOString(), mission, state: error, items: error, progress: error, git: error, history: error, evidence: null, journal: error, counterBaseline,
						runStarts, progressAt: new Map(), lastGood, issues: [{ source: "observer", kind: "unavailable", detail: "reader closed" }],
					});
				}
				active = new AbortController();
				const onAbort = () => active?.abort();
				signal?.addEventListener("abort", onAbort);
				if (signal?.aborted) active.abort();
				try {
					return await observe(active.signal);
				} finally {
					signal?.removeEventListener("abort", onAbort);
					active = null;
				}
			};
			const result = queue.then(run, run);
			queue = result.catch(() => undefined);
			return result;
		},
		async close(): Promise<void> {
			closed = true;
			active?.abort();
			await queue;
		},
	};
}

function classify(sha: string, facts: CommitFacts, parent: CommitFacts | null, mission: Mission): CommitEvent {
	const committedAt = Number.isFinite(Date.parse(facts.committedAt)) ? facts.committedAt : null;
	const now = facts.items.kind === "ok" ? facts.items.passes : null;
	const before = parent?.items.kind === "ok" ? parent.items.passes : null;
	// Invalid items, or items.json present in only one of commit and first parent
	// (deleted or restored), hide whether an item passed here.
	const presence = (at: CommitFacts | null) => at?.items.kind ?? "absent";
	const passesKnown = facts.items.kind !== "invalid" && parent?.items.kind !== "invalid"
		&& (presence(facts) === "absent") === (presence(parent) === "absent");
	// Only false->true flips on keys present in both versions count as passes.
	// Merges are not classified: which parent a flip came from is ambiguous.
	const passedItems = facts.parents.length <= 1 && now && before
		? [...now].filter(([key, passes]) => passes && before.get(key) === false).map(([key]) => key)
		: [];
	let blockerItem: string | null = null;
	if (mission.blocker && facts.parents.length <= 1) {
		const captured = new RegExp(mission.blocker.subjectRegex).exec(facts.subject)?.groups?.[mission.blocker.itemGroup];
		// An unknown captured item is not bound to a real item.
		if (captured !== undefined && now?.has(captured)) blockerItem = captured;
	}
	const parentReason = mission.git.parentCommits.find((p) => p.sha === sha)?.reason ?? null;
	const kind = passedItems.length ? "item-pass" : blockerItem ? "blocker" : parentReason ? "parent" : "other";
	return { sha, parents: facts.parents, subject: facts.subject, committedAt, kind, passedItems, blockerItem, parentReason, passesKnown };
}
