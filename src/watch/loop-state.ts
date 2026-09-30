import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { lstat, open, readlink, stat } from "node:fs/promises";
import path from "node:path";

import { parseBundleItemsJson } from "../bundle/schema.js";
import type { BundleItem } from "../bundle/types.js";
import { readStateDocument, type StateDocument } from "../state.js";
import { loadMission, MissionConfigError } from "./config.js";
import { parseProgress, type AttemptCard } from "./progress.js";
import type {
	CommitEvent, GitObservation, Issue, ItemStatus, LoopReader, LoopSnapshot, Mission,
	ObservedAttempt, ObservedItem, RetainedValues, RunStart, SourceName, SourceStatus,
} from "./types.js";

const LOOP_FILE = ".ralph/loop.md";
const ITEMS_FILE = ".ralph/items.json";
const PROGRESS_FILE = ".ralph/progress.md";
const MISSION_FILE = ".ralph/mission.json";

export type FileStamp = { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeNs: bigint };

/** A git command that ran and exited nonzero. Any other rejection is an operational failure. */
export class GitCommandError extends Error {
	constructor(message: string, readonly exitCode: number | null) {
		super(message);
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
		} catch {
			return null;
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

/** Everything derivation needs. Collected by the reader; pure input to deriveLoopSnapshot. */
export type LoopObservation = {
	readonly root: string;
	readonly observedAt: string;
	readonly mission: Mission | null;
	readonly state: StateDocument;
	/** Null when no bundle applies or the items source is not fresh. */
	readonly items: readonly KeyedItem[] | null;
	readonly cards: readonly AttemptCard[];
	/** Run starts with their source. The journal (T8) will add records here. */
	readonly runStarts: readonly RunStart[];
	readonly git: GitObservation | null;
	/** Committed progress cards per commit SHA, for pass commits and their first parents. */
	readonly progressAt: ReadonlyMap<string, readonly AttemptCard[] | null>;
	/** Reader-assigned availability; derivation marks unavailable sources with retained values stale. */
	readonly sources: Readonly<Record<SourceName, SourceStatus>>;
	/** Last good values from earlier reads, shown only for sources that are not fresh. */
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

/** Pure derivation: no filesystem, subprocess or clock access. */
export function deriveLoopSnapshot(o: LoopObservation): LoopSnapshot {
	const issues: Issue[] = [...o.issues];
	const state = o.sources.state === "fresh" && o.state.status === "valid" ? o.state.state : null;
	const commits = o.git?.commits ?? null;
	const keyed = o.items ?? [];
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
		for (let i = commits.length - 1; i > lastPass; i--) {
			if (commits[i].kind === "blocker" && commits[i].blockerItem === key) return commits[i];
		}
		return null;
	};

	let currentItem: string | null = null;
	let stoppedItem: string | null = null;
	let firstStatus: ItemStatus = "pending";
	if (firstFalse && state) {
		const blocker = newBlocker(firstFalse.key);
		if (!commits) {
			issues.push({ source: "git", kind: "unavailable", detail: "blocker history unavailable; retry and blocked cannot be proven" });
		}
		if (state.running) {
			currentItem = firstFalse.key;
			firstStatus = blocker ? "retry" : "working";
		} else {
			stoppedItem = firstFalse.key;
			const start = Date.parse(state.started_at);
			const at = blocker?.committedAt == null ? Number.NaN : Date.parse(blocker.committedAt);
			if (blocker && !(Number.isFinite(start) && Number.isFinite(at))) {
				issues.push({ source: blocker && Number.isFinite(start) ? "git" : "state", kind: "partial", detail: "blocker or run start time is invalid; blocked cannot be proven" });
			}
			// Strictly newer than the run start: equality is not newer.
			firstStatus = blocker && Number.isFinite(start) && at > start ? "blocked" : "stopped";
		}
	} else if (firstFalse) {
		issues.push({ source: "state", kind: "unavailable", detail: "loop state not fresh and valid; item activity unknown" });
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
	for (const card of o.cards) {
		if (card.outcome !== "passed" || card.id === null || !keys.has(card.id)) continue;
		const found = passCommit(card, commits, o.progressAt);
		if (found.issue) issues.push({ source: "progress", kind: "partial", detail: found.issue });
		commitFor.set(card.index, found.sha);
	}
	const attempts: ObservedAttempt[] = o.cards.map((card) => ({
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

	// A source that is not fresh shows its last good value, marked stale.
	const sources = { ...o.sources };
	const retain = <K extends keyof RetainedValues>(name: SourceName, key: K): RetainedValues[K] => {
		if (sources[name] === "fresh" || sources[name] === "not-applicable" || !o.lastGood[key]) return null;
		if (sources[name] === "unavailable") sources[name] = "stale";
		return o.lastGood[key];
	};
	const retained: RetainedValues = {
		state: retain("state", "state"), items: retain("items", "items"),
		attempts: retain("progress", "attempts"), git: retain("git", "git"),
	};

	return freeze({
		root: o.root,
		observedAt: o.observedAt,
		mission: o.mission,
		task: o.mission?.task.kind ?? (state ? (state.bundle_mode ? "bundle" : "plain") : null),
		run: { launchId: null, loopToken: state?.loop_token ?? null, startedAt: state?.started_at ?? null },
		state,
		items, currentItem, stoppedItem, attempts, itemAttempts,
		runStarts: [...o.runStarts],
		historyComplete: false,
		git: o.git,
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
 * The single item-pass commit that flips this card's item and introduces this
 * complete entry at the same index (absent at its first parent). A committed
 * entry that predates its flip, or several candidates, give null plus an issue.
 */
function passCommit(
	card: AttemptCard,
	commits: readonly CommitEvent[] | null,
	progressAt: ReadonlyMap<string, readonly AttemptCard[] | null>,
): { sha: string | null; issue: string | null } {
	const holds = (sha: string | undefined) => {
		const committed = sha === undefined ? undefined : progressAt.get(sha)?.[card.index];
		return !!committed && committed.outcome === "passed" && committed.id === card.id && committed.raw.trimEnd() === card.raw.trimEnd();
	};
	const candidates = (commits ?? []).filter((c) => c.passedItems.includes(card.id!) && holds(c.sha));
	if (!candidates.length) return { sha: null, issue: null };
	const introduced = candidates.filter((c) => c.parents[0] !== undefined && progressAt.has(c.parents[0]) && !holds(c.parents[0]));
	if (introduced.length === 1 && candidates.length === 1) return { sha: introduced[0].sha, issue: null };
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
	let stateCache: { stamp: FileStamp; doc: StateDocument } | null = null;
	let itemsCache: { stamp: FileStamp; items: readonly BundleItem[] | string } | null = null;
	let progress: ProgressCache | null = null;
	// Immutable git facts, cached only after a successful read.
	const commitCache = new Map<string, CommitFacts>();
	const blobCards = new Map<string, readonly AttemptCard[]>();
	const contentHashes = new Map<string, { stamp: FileStamp; hash: string }>();
	const runStarts: RunStart[] = [];
	const lastGood: { -readonly [K in keyof RetainedValues]: RetainedValues[K] } = { state: null, items: null, attempts: null, git: null };
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

	type Read<T> = { stamp: FileStamp | null; status: SourceStatus; value: T };

	async function readStateFile(issues: Issue[]): Promise<Read<StateDocument>> {
		const stamp = await rt.stat(file(LOOP_FILE));
		if (!stamp) {
			stateCache = null;
			issues.push({ source: "state", kind: "missing", detail: `${LOOP_FILE} not found` });
			return { stamp, status: "missing", value: { status: "missing" } };
		}
		if (!stateCache || !sameFile(stateCache.stamp, stamp)) {
			const doc = readStateDocument(root);
			if (!sameFile(stamp, await rt.stat(file(LOOP_FILE)))) {
				stateCache = null;
				issues.push({ source: "state", kind: "concurrent", detail: `${LOOP_FILE} changed during read` });
				return { stamp, status: "unavailable", value: { status: "partial", reason: "changed during read", body: null, fields: {} } };
			}
			stateCache = { stamp, doc };
		}
		const doc = stateCache.doc;
		if (doc.status === "partial") issues.push({ source: "state", kind: "partial", detail: doc.reason });
		return { stamp, status: doc.status === "valid" ? "fresh" : "unavailable", value: doc };
	}

	async function readItems(issues: Issue[]): Promise<Read<KeyedItem[] | null>> {
		const stamp = await rt.stat(file(ITEMS_FILE));
		if (!stamp) {
			itemsCache = null;
			issues.push({ source: "items", kind: "missing", detail: `${ITEMS_FILE} not found` });
			return { stamp, status: "missing", value: null };
		}
		if (!itemsCache || !sameFile(itemsCache.stamp, stamp)) {
			let items: readonly BundleItem[] | string;
			try {
				items = parseBundleItemsJson((await rt.readRange(file(ITEMS_FILE), 0)).toString("utf8")).items;
			} catch (error) {
				items = message(error);
			}
			if (!sameFile(stamp, await rt.stat(file(ITEMS_FILE)))) {
				itemsCache = null;
				issues.push({ source: "items", kind: "concurrent", detail: `${ITEMS_FILE} changed during read` });
				return { stamp, status: "unavailable", value: null };
			}
			itemsCache = { stamp, items };
		}
		const keyed = typeof itemsCache.items === "string" ? itemsCache.items : keyItems(itemsCache.items);
		if (typeof keyed === "string") {
			issues.push({ source: "items", kind: "partial", detail: keyed });
			return { stamp, status: "unavailable", value: null };
		}
		return { stamp, status: "fresh", value: keyed };
	}

	/**
	 * Unchanged files are not read. A changed file is read once; the cached
	 * prefix is reused only when its hash still matches, so an edit anywhere in
	 * old content is detected and reparsed with an issue.
	 */
	async function readProgress(issues: Issue[]): Promise<Read<readonly AttemptCard[] | null>> {
		const stamp = await rt.stat(file(PROGRESS_FILE));
		if (!stamp) {
			progress = null;
			issues.push({ source: "progress", kind: "missing", detail: `${PROGRESS_FILE} not found` });
			return { stamp, status: "missing", value: null };
		}
		if (progress && sameFile(progress.stamp, stamp)) return { stamp, status: "fresh", value: progress.cards };
		const bytes = await rt.readRange(file(PROGRESS_FILE), 0, stamp.size);
		if (!sameFile(stamp, await rt.stat(file(PROGRESS_FILE)))) {
			issues.push({ source: "progress", kind: "concurrent", detail: `${PROGRESS_FILE} changed during read` });
			return { stamp, status: "unavailable", value: null };
		}
		if (progress && (bytes.length < progress.bytes || sha256(bytes.subarray(0, progress.bytes)) !== progress.prefixHash)) {
			issues.push({ source: "progress", kind: "partial", detail: `${PROGRESS_FILE} was edited, not appended; reparsed` });
		}
		progress = { stamp, bytes: bytes.length, prefixHash: sha256(bytes), cards: parseProgress(bytes.toString("utf8")) };
		return { stamp, status: "fresh", value: progress.cards };
	}

	/**
	 * HEAD, branch, index bytes and the content and mode of every modified,
	 * deleted or untracked nonignored path. Any failure except the detached-HEAD
	 * exit throws.
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
		const index = (await rt.stat(indexPath)) ? sha256(await rt.readRange(indexPath, 0)) : "absent";
		const dirty = [...new Set((await rt.git(root, ["ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard"], signal)).split("\0").filter(Boolean))].sort();
		const content: string[] = [];
		for (const rel of dirty) {
			const full = path.join(root, rel);
			const info = await lstat(full).catch(() => null);
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
		const cached = contentHashes.get(full);
		if (stamp && cached && sameFile(cached.stamp, stamp)) return cached.hash;
		const hash = sha256(await rt.readRange(full, 0));
		if (stamp && sameFile(stamp, await rt.stat(full))) contentHashes.set(full, { stamp, hash });
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

	async function readGit(issues: Issue[], signal: AbortSignal, progressOut: Map<string, readonly AttemptCard[] | null>, head: string): Promise<CommitEvent[] | null> {
		const base = mission?.git.baseCommit ?? null;
		if (base === null) {
			issues.push({ source: "git", kind: "unavailable", detail: "no mission base; commit history unavailable" });
			return null;
		}
		try {
			try {
				await rt.git(root, ["merge-base", "--is-ancestor", base, head], signal);
			} catch (error) {
				// Exit 1 proves non-ancestry; anything else is unknown, not a history fact.
				if (!(error instanceof GitCommandError && error.exitCode === 1)) throw error;
				issues.push({ source: "git", kind: "partial", detail: `base ${base} is not an ancestor of HEAD; history incomplete` });
				return null;
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
			return commits;
		} catch (error) {
			if (signal.aborted) throw error;
			issues.push({ source: "git", kind: "unavailable", detail: `history unavailable: ${message(error)}` });
			return null;
		}
	}

	async function observe(signal: AbortSignal): Promise<LoopSnapshot> {
		const issues: Issue[] = [];
		const observedAt = rt.now().toISOString();
		const sources: Record<SourceName, SourceStatus> = { state: "unavailable", items: "not-applicable", progress: "not-applicable", git: "unavailable" };
		const base: LoopObservation = { root, observedAt, mission, state: { status: "missing" }, items: null, cards: [], runStarts, git: null, progressAt: new Map(), sources, lastGood, issues };
		try {
			signal.throwIfAborted();
			await readMission(issues);
			// The git window opens before any source read, so it covers the whole observation.
			let before: Awaited<ReturnType<typeof gitStamp>> | null = null;
			try {
				before = await gitStamp(signal);
			} catch (error) {
				if (signal.aborted) throw error;
				issues.push({ source: "git", kind: "unavailable", detail: message(error) });
			}
			const state = await readStateFile(issues);
			const bundle = mission ? mission.task.kind === "bundle" : state.value.status === "valid" ? state.value.state.bundle_mode : existsSync(file(ITEMS_FILE));
			const items = bundle ? await readItems(issues) : null;
			const cards = bundle ? await readProgress(issues) : null;
			const progressAtPass = new Map<string, readonly AttemptCard[] | null>();
			let git: GitObservation | null = null;
			if (before) {
				const commits = await readGit(issues, signal, progressAtPass, before.head);
				const after = await gitStamp(signal).catch((error) => {
					if (signal.aborted) throw error;
					return null;
				});
				if (after?.digest !== before.digest) {
					// No tight retry loop: the next read retries and publishes one coherent result.
					issues.push({ source: "git", kind: "concurrent", detail: "HEAD, index or worktree changed during read; retry next poll" });
				} else {
					git = { head: before.head, branch: before.branch, base: mission?.git.baseCommit ?? null, commits };
				}
			}
			signal.throwIfAborted();
			// Every source must be unchanged from its read to the end of the observation.
			for (const [name, rel, read] of [["state", LOOP_FILE, state], ["items", ITEMS_FILE, items], ["progress", PROGRESS_FILE, cards]] as const) {
				if (!read) continue;
				sources[name] = read.status;
				if (read.status !== "missing" && !sameFile(read.stamp, await rt.stat(file(rel)))) {
					issues.push({ source: name, kind: "concurrent", detail: `${rel} changed during observation; retry next poll` });
					sources[name] = "unavailable";
				}
			}
			sources.git = git ? "fresh" : "unavailable";
			if (sources.state === "fresh" && state.value.status === "valid") {
				const s = state.value.state;
				if (!Number.isFinite(Date.parse(s.started_at))) {
					issues.push({ source: "state", kind: "partial", detail: "started_at is not a valid time; no run boundary" });
				} else if (!runStarts.some((r) => r.loopToken === s.loop_token && r.startedAt === s.started_at)) {
					runStarts.push({ source: "state", loopToken: s.loop_token, startedAt: s.started_at });
				}
			}
			const snapshot = deriveLoopSnapshot({
				...base, mission, state: state.value,
				items: sources.items === "fresh" ? items!.value : null,
				cards: sources.progress === "fresh" ? cards!.value ?? [] : [],
				git, progressAt: progressAtPass,
			});
			remember(snapshot);
			return snapshot;
		} catch (error) {
			issues.push({ source: "observer", kind: "unavailable", detail: signal.aborted ? "read aborted" : message(error) });
			return deriveLoopSnapshot({ ...base, mission });
		}
	}

	function remember(s: LoopSnapshot): void {
		if (s.sources.state === "fresh" && s.state) lastGood.state = { value: s.state, observedAt: s.observedAt };
		if (s.sources.items === "fresh") lastGood.items = { value: s.items, observedAt: s.observedAt };
		if (s.sources.progress === "fresh") lastGood.attempts = { value: s.attempts, observedAt: s.observedAt };
		if (s.sources.git === "fresh" && s.git) lastGood.git = { value: s.git, observedAt: s.observedAt };
	}

	return {
		read(signal?: AbortSignal): Promise<LoopSnapshot> {
			const run = async (): Promise<LoopSnapshot> => {
				if (closed) {
					const sources = { state: "unavailable", items: "unavailable", progress: "unavailable", git: "unavailable" } as const;
					return deriveLoopSnapshot({
						root, observedAt: rt.now().toISOString(), mission, state: { status: "missing" }, items: null, cards: [], runStarts, git: null,
						progressAt: new Map(), sources, lastGood, issues: [{ source: "observer", kind: "unavailable", detail: "reader closed" }],
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
	return { sha, parents: facts.parents, subject: facts.subject, committedAt, kind, passedItems, blockerItem, parentReason };
}
