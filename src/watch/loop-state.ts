import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { parseBundleItemsJson } from "../bundle/schema.js";
import type { BundleItem } from "../bundle/types.js";
import { readStateDocument, type StateDocument } from "../state.js";
import { loadMission, MissionConfigError } from "./config.js";
import { parseProgress, type AttemptCard } from "./progress.js";
import type {
	CommitEvent, GitObservation, Issue, ItemStatus, LoopReader, LoopSnapshot, Mission,
	ObservedAttempt, ObservedItem, RunStart,
} from "./types.js";

const LOOP_FILE = ".ralph/loop.md";
const ITEMS_FILE = ".ralph/items.json";
const PROGRESS_FILE = ".ralph/progress.md";
const MISSION_FILE = ".ralph/mission.json";

export type FileStamp = { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeNs: bigint };

/** The one observation boundary: clock, file reads and read-only git. Tests wrap it. */
export type ObservationRuntime = {
	now(): Date;
	stat(file: string): Promise<FileStamp | null>;
	/** Bytes [start, end) of a file; end undefined reads to the end. */
	readRange(file: string, start: number, end?: number): Promise<Buffer>;
	/** Runs `git --no-optional-locks <args>` in root with argv only. Rejects on nonzero exit. */
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
				else reject(new Error(`git ${args[0]} exited ${code}: ${Buffer.concat(err).toString("utf8").trim()}`));
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
	/** Null when no bundle applies (plain task or unknown task). */
	readonly items: readonly KeyedItem[] | null;
	readonly cards: readonly AttemptCard[];
	/** Run starts with their source. The journal (T8) will add records here. */
	readonly runStarts: readonly RunStart[];
	readonly git: GitObservation | null;
	/** Progress cards as committed at each item-pass commit, for card-to-commit association. */
	readonly progressAt: ReadonlyMap<string, readonly AttemptCard[] | null>;
	readonly issues: readonly Issue[];
};

/** Item key: explicit nonblank id, else `index:N`. Descriptions are never keys. */
export function keyItems(items: readonly BundleItem[]): KeyedItem[] | string {
	const keyed = items.map((item, index) => {
		const id = typeof item.id === "string" && item.id.trim() ? item.id : null;
		return { key: id ?? `index:${index}`, index, item };
	});
	const keys = new Set(keyed.map((k) => k.key));
	if (keys.size !== keyed.length) return "duplicate bundle item key";
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
	const state = o.state.status === "valid" ? o.state.state : null;
	const commits = o.git?.commits ?? null;
	const keyed = o.items ?? [];
	const keys = new Set(keyed.map((k) => k.key));
	const firstFalse = keyed.find((k) => k.item.passes !== true) ?? null;

	// Pass recency uses commit graph order, not commit timestamps.
	let lastPass = -1;
	commits?.forEach((c, i) => { if (c.kind === "item-pass") lastPass = i; });
	const newBlocker = (key: string): CommitEvent | null => {
		if (!commits) return null;
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
			if (blocker && !Number.isFinite(start)) {
				issues.push({ source: "state", kind: "partial", detail: "started_at is not a valid time; blocked cannot be proven" });
			}
			// Strictly newer than the run start: equality is not newer.
			firstStatus = blocker && Number.isFinite(start) && Date.parse(blocker.committedAt) > start ? "blocked" : "stopped";
		}
	} else if (firstFalse) {
		issues.push({ source: "state", kind: "unavailable", detail: "loop state not valid; item activity unknown" });
	}

	const items: ObservedItem[] = keyed.map(({ key, index, item }) => ({
		key, index,
		id: typeof item.id === "string" && item.id.trim() ? item.id : null,
		title: itemTitle(item, key, o.mission),
		description: item.description,
		passes: item.passes === true,
		regressionNotes: item.regression_notes,
		status: item.passes === true ? "passed" : key === firstFalse?.key ? firstStatus : "pending",
	}));

	const commitFor = new Map<number, string | null>();
	for (const card of o.cards) {
		if (card.outcome !== "passed" || card.id === null || !keys.has(card.id)) continue;
		commitFor.set(card.index, passCommit(card, commits, o.progressAt));
	}
	const attempts: ObservedAttempt[] = o.cards.map((card) => ({
		...card,
		commitSha: commitFor.get(card.index) ?? null,
		resolvedCommitSha: card.resolvedBy === null ? null : commitFor.get(card.resolvedBy) ?? null,
	}));
	const itemAttempts: Record<string, ObservedAttempt[]> = {};
	for (const key of keys) {
		const own = attempts.filter((a) => a.id === key);
		const open = own.filter((a) => a.outcome === "blocked" && a.resolvedBy === null).reverse();
		const rest = own.filter((a) => !open.includes(a)).reverse();
		itemAttempts[key] = [...open, ...rest];
	}

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
		issues,
	} satisfies LoopSnapshot);
}

function itemTitle(item: BundleItem, key: string, mission: Mission | null): string {
	if (typeof item.title === "string" && item.title.trim()) return item.title;
	const scoped = mission?.scope.items.find((s) => s.id === key)?.title;
	return scoped ?? item.description;
}

/**
 * The first item-pass commit that flips this card's item and whose committed
 * progress holds this complete entry at the same index. Otherwise null.
 */
function passCommit(
	card: AttemptCard,
	commits: readonly CommitEvent[] | null,
	progressAt: ReadonlyMap<string, readonly AttemptCard[] | null>,
): string | null {
	for (const commit of commits ?? []) {
		if (!commit.passedItems.includes(card.id!)) continue;
		const committed = progressAt.get(commit.sha)?.[card.index];
		if (committed && committed.outcome === "passed" && committed.id === card.id && committed.raw.trimEnd() === card.raw.trimEnd()) {
			return commit.sha;
		}
	}
	return null;
}

type CommitFacts = {
	readonly parents: readonly string[];
	readonly subject: string;
	readonly committedAt: string;
	readonly passes: ReadonlyMap<string, boolean> | null;
};

type ProgressCache = { stamp: FileStamp; bytes: number; text: string; decoder: StringDecoder; cards: readonly AttemptCard[] };

function sameFile(a: FileStamp | null, b: FileStamp | null): boolean {
	return !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

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
	const commitCache = new Map<string, CommitFacts>();
	const progressCache = new Map<string, readonly AttemptCard[] | null>();
	const runStarts: RunStart[] = [];
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

	async function readStateFile(issues: Issue[]): Promise<StateDocument> {
		const stamp = await rt.stat(file(LOOP_FILE));
		if (!stamp) { stateCache = null; issues.push({ source: "state", kind: "missing", detail: `${LOOP_FILE} not found` }); return { status: "missing" }; }
		if (!stateCache || !sameFile(stateCache.stamp, stamp)) {
			const doc = readStateDocument(root);
			const after = await rt.stat(file(LOOP_FILE));
			if (!sameFile(stamp, after)) {
				stateCache = null;
				issues.push({ source: "state", kind: "concurrent", detail: `${LOOP_FILE} changed during read` });
				return { status: "partial", reason: "changed during read", body: null, fields: {} };
			}
			stateCache = { stamp, doc };
		}
		const doc = stateCache.doc;
		if (doc.status === "partial") issues.push({ source: "state", kind: "partial", detail: doc.reason });
		if (doc.status === "valid") {
			const s = doc.state;
			if (!Number.isFinite(Date.parse(s.started_at))) {
				issues.push({ source: "state", kind: "partial", detail: "started_at is not a valid time; no run boundary" });
			} else if (!runStarts.some((r) => r.loopToken === s.loop_token && r.startedAt === s.started_at)) {
				runStarts.push({ source: "state", loopToken: s.loop_token, startedAt: s.started_at });
			}
		}
		return doc;
	}

	async function readItems(issues: Issue[]): Promise<KeyedItem[] | null> {
		const stamp = await rt.stat(file(ITEMS_FILE));
		if (!stamp) { itemsCache = null; issues.push({ source: "items", kind: "missing", detail: `${ITEMS_FILE} not found` }); return null; }
		if (!itemsCache || !sameFile(itemsCache.stamp, stamp)) {
			let items: readonly BundleItem[] | string;
			try {
				items = parseBundleItemsJson((await rt.readRange(file(ITEMS_FILE), 0)).toString("utf8")).items;
			} catch (error) {
				items = error instanceof Error ? error.message : String(error);
			}
			if (!sameFile(stamp, await rt.stat(file(ITEMS_FILE)))) {
				itemsCache = null;
				issues.push({ source: "items", kind: "concurrent", detail: `${ITEMS_FILE} changed during read` });
				return null;
			}
			itemsCache = { stamp, items };
		}
		const keyed = typeof itemsCache.items === "string" ? itemsCache.items : keyItems(itemsCache.items);
		if (typeof keyed === "string") { issues.push({ source: "items", kind: "partial", detail: keyed }); return null; }
		return keyed;
	}

	/** Append-only tail: unchanged files are not read; appends read only the new suffix. */
	async function readProgress(issues: Issue[]): Promise<readonly AttemptCard[]> {
		const stamp = await rt.stat(file(PROGRESS_FILE));
		if (!stamp) { progress = null; issues.push({ source: "progress", kind: "missing", detail: `${PROGRESS_FILE} not found` }); return []; }
		if (progress && sameFile(progress.stamp, stamp)) return progress.cards;
		const appended = progress && progress.stamp.dev === stamp.dev && progress.stamp.ino === stamp.ino && stamp.size >= progress.bytes;
		// Truncation or replacement resets; the initial parse necessarily sees the full file.
		const base = appended ? progress! : { bytes: 0, text: "", decoder: new StringDecoder("utf8") };
		const chunk = await rt.readRange(file(PROGRESS_FILE), base.bytes, stamp.size);
		if (!sameFile(stamp, await rt.stat(file(PROGRESS_FILE)))) {
			issues.push({ source: "progress", kind: "concurrent", detail: `${PROGRESS_FILE} changed during read` });
			return progress?.cards ?? [];
		}
		// The decoder carries a split UTF-8 sequence to the next append.
		const decoder = base.decoder;
		const text = base.text + decoder.write(chunk);
		progress = { stamp, bytes: base.bytes + chunk.length, text, decoder, cards: parseProgress(text) };
		return progress.cards;
	}

	async function gitState(signal: AbortSignal): Promise<string> {
		const git = (args: string[]) => rt.git(root, args, signal).catch(() => "");
		const head = await rt.git(root, ["rev-parse", "--verify", "HEAD"], signal);
		const branch = await git(["symbolic-ref", "-q", "--short", "HEAD"]);
		const indexPath = (await git(["rev-parse", "--git-path", "index"])).trim();
		const indexStamp = indexPath ? await rt.stat(path.resolve(root, indexPath)) : null;
		const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
		return JSON.stringify([head.trim(), branch.trim(), indexStamp && { ...indexStamp, mtimeNs: String(indexStamp.mtimeNs) }, createHash("sha256").update(status).digest("hex")]);
	}

	async function commitFacts(sha: string, signal: AbortSignal): Promise<CommitFacts> {
		const cached = commitCache.get(sha);
		if (cached) return cached;
		const [committedAt, subject, parentList] = (await rt.git(root, ["show", "-s", "--format=%cI%x00%s%x00%P", sha], signal)).replace(/\n$/, "").split("\0");
		let passes: Map<string, boolean> | null = null;
		try {
			const keyed = keyItems(parseBundleItemsJson(await rt.git(root, ["show", `${sha}:${ITEMS_FILE}`], signal)).items);
			if (typeof keyed !== "string") passes = new Map(keyed.map((k) => [k.key, k.item.passes === true]));
		} catch { /* No readable items file at this commit. */ }
		const facts = { committedAt, subject, parents: (parentList ?? "").split(" ").filter(Boolean), passes };
		commitCache.set(sha, facts);
		return facts;
	}

	async function progressAt(sha: string, signal: AbortSignal): Promise<readonly AttemptCard[] | null> {
		if (!progressCache.has(sha)) {
			const text = await rt.git(root, ["show", `${sha}:${PROGRESS_FILE}`], signal).catch(() => null);
			progressCache.set(sha, text === null ? null : parseProgress(text));
		}
		return progressCache.get(sha)!;
	}

	async function readGit(issues: Issue[], signal: AbortSignal, progressOut: Map<string, readonly AttemptCard[] | null>): Promise<GitObservation | null> {
		let before: string;
		try {
			before = await gitState(signal);
		} catch (error) {
			if (signal.aborted) throw error;
			issues.push({ source: "git", kind: "unavailable", detail: error instanceof Error ? error.message : String(error) });
			return null;
		}
		const [head, branch] = JSON.parse(before) as [string, string];
		const base = mission?.git.baseCommit ?? null;
		let commits: CommitEvent[] | null = null;
		try {
			if (base === null) {
				issues.push({ source: "git", kind: "unavailable", detail: "no mission base; commit history unavailable" });
			} else if (!(await rt.git(root, ["merge-base", "--is-ancestor", base, head], signal).then(() => true, () => false))) {
				issues.push({ source: "git", kind: "partial", detail: `base ${base} is not an ancestor of HEAD; history incomplete` });
			} else {
				const list = (await rt.git(root, ["rev-list", "--reverse", "--topo-order", `${base}..${head}`], signal)).split("\n").filter(Boolean);
				commits = [];
				for (const sha of list) {
					const facts = await commitFacts(sha, signal);
					const parent = facts.parents[0] ? await commitFacts(facts.parents[0], signal) : null;
					commits.push(classify(sha, facts, parent, mission!));
					if (commits.at(-1)!.kind === "item-pass") progressOut.set(sha, await progressAt(sha, signal));
				}
			}
		} catch (error) {
			if (signal.aborted) throw error;
			issues.push({ source: "git", kind: "unavailable", detail: error instanceof Error ? error.message : String(error) });
			commits = null;
		}
		const after = await gitState(signal).catch(() => "");
		if (after !== before) {
			// No tight retry loop: the next read retries and publishes one coherent result.
			issues.push({ source: "git", kind: "concurrent", detail: "HEAD, index or worktree changed during read; retry next poll" });
			return null;
		}
		return { head, branch: branch || null, base, commits };
	}

	async function observe(signal: AbortSignal): Promise<LoopSnapshot> {
		const issues: Issue[] = [];
		const observedAt = rt.now().toISOString();
		const empty: LoopObservation = { root, observedAt, mission, state: { status: "missing" }, items: null, cards: [], runStarts, git: null, progressAt: new Map(), issues };
		try {
			signal.throwIfAborted();
			await readMission(issues);
			const state = await readStateFile(issues);
			const bundle = mission ? mission.task.kind === "bundle" : state.status === "valid" ? state.state.bundle_mode : existsSync(file(ITEMS_FILE));
			const items = bundle ? await readItems(issues) : null;
			const cards = bundle ? await readProgress(issues) : [];
			const progressAtPass = new Map<string, readonly AttemptCard[] | null>();
			const git = await readGit(issues, signal, progressAtPass);
			signal.throwIfAborted();
			return deriveLoopSnapshot({ ...empty, mission, state, items, cards, git, progressAt: progressAtPass });
		} catch (error) {
			issues.push({ source: "observer", kind: "unavailable", detail: signal.aborted ? "read aborted" : error instanceof Error ? error.message : String(error) });
			return deriveLoopSnapshot({ ...empty, mission });
		}
	}

	return {
		read(signal?: AbortSignal): Promise<LoopSnapshot> {
			const run = async (): Promise<LoopSnapshot> => {
				const observedAt = rt.now().toISOString();
				if (closed) {
					return deriveLoopSnapshot({ root, observedAt, mission, state: { status: "missing" }, items: null, cards: [], runStarts, git: null, progressAt: new Map(), issues: [{ source: "observer", kind: "unavailable", detail: "reader closed" }] });
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
	// Only false->true flips on keys present in both versions count as passes.
	const passedItems = facts.passes && parent?.passes
		? [...facts.passes].filter(([key, passes]) => passes && parent.passes!.get(key) === false).map(([key]) => key)
		: [];
	let blockerItem: string | null = null;
	if (mission.blocker) {
		const captured = new RegExp(mission.blocker.subjectRegex).exec(facts.subject)?.groups?.[mission.blocker.itemGroup];
		// An unknown captured item is not bound to a real item.
		if (captured !== undefined && facts.passes?.has(captured)) blockerItem = captured;
	}
	const parentReason = mission.git.parentCommits.find((p) => p.sha === sha)?.reason ?? null;
	const kind = passedItems.length ? "item-pass" : blockerItem ? "blocker" : parentReason ? "parent" : "other";
	return { sha, parents: facts.parents, subject: facts.subject, committedAt: facts.committedAt, kind, passedItems, blockerItem, parentReason };
}
