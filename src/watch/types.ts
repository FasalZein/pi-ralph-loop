// Authority: owner decision Q1 on #17, 2026-10-06. Text is live-only, never journaled.
export const MESSAGE_CHARS = 500;

/** Identity evidence for a launch and its loop. */
export type RunKey = {
	readonly launchId: string | null;
	readonly loopToken: string | null;
	readonly startedAt: string | null;
};

/** An observation that could not be completed consistently. */
export type Issue = {
	readonly source: string;
	readonly kind: "missing" | "partial" | "unavailable" | "concurrent";
	readonly detail: string;
};

/** A request to stop or steer a loop. */
export type Control =
	| { readonly kind: "stop" }
	| { readonly kind: "steer"; readonly text: string };

/** A control request's observed lifecycle phase. */
export type Receipt = {
	readonly id: string;
	readonly run: RunKey;
	readonly phase: "sent" | "accepted" | "completed";
	/** Driver's reason, e.g. `not-launched` when stop completed before dispatch. */
	readonly reason?: string;
};

/** Evidence from a watch rule evaluation. */
export type Alert = {
	readonly timestamp: string;
	readonly level: "HARD" | "WARN" | "INFO";
	readonly rule: string;
	readonly item: string | null;
	readonly commit: string | null;
	readonly evidence: readonly string[];
	readonly run: RunKey;
};

/** JSON metadata copied from the bundle and recursively frozen by the loader. */
export type DeepReadonly<T> = T extends readonly (infer U)[]
	? readonly DeepReadonly<U>[]
	: T extends object
		? { readonly [K in keyof T]: DeepReadonly<T[K]> }
		: T;

export type RuleLevel = "off" | "warn" | "hard";
export type MissionThinkingLevel = ReturnType<
	import("@earendil-works/pi-coding-agent").ExtensionAPI["getThinkingLevel"]
>;
export type MissionItemScope = {
	readonly id: string;
	readonly title?: string;
	readonly allowedPaths: readonly string[];
	readonly targets: readonly string[];
};
export type MissionBaseline = {
	readonly name: string;
	readonly file: string;
	readonly schema: {
		readonly kind: "counter-map" | "entry-array";
		readonly pointer: string;
	};
};
export type MissionPolicy = {
	readonly version: 1;
	readonly loop: { readonly id: string; readonly displayName: string };
	readonly run: {
		readonly model: string;
		readonly thinking: MissionThinkingLevel;
		readonly maxIterations: number;
		readonly budgetAuthority: string;
	};
	readonly git: {
		readonly baseCommit: string;
		readonly branch: string | null;
		readonly parentCommits: readonly {
			readonly sha: string;
			readonly reason: string;
		}[];
	};
	readonly scope: {
		readonly sourceGlobs: readonly string[];
		readonly testGlobs: readonly string[];
		readonly sourceRegex: string | null;
		readonly testRegex: string | null;
		readonly items: readonly MissionItemScope[];
		readonly receiptItems: readonly string[];
		readonly importerCommand: readonly string[] | null;
	};
	readonly protected: {
		readonly paths: readonly string[];
		readonly prefixes: readonly string[];
	};
	readonly otherAreas: readonly {
		readonly name: string;
		readonly globs: readonly string[];
	}[];
	readonly baselines: readonly MissionBaseline[];
	readonly measure: {
		readonly command: readonly string[];
		readonly start: Readonly<Record<string, number>>;
	} | null;
	readonly rules: Readonly<Record<string, RuleLevel>>;
	readonly thresholds: {
		readonly authority: string;
		readonly largeDiffPaths?: number;
		readonly largeDiffLines?: number;
	} | null;
	readonly blocker: {
		readonly subjectRegex: string;
		readonly itemGroup: string;
	} | null;
	readonly testEdit: {
		readonly mode: "arguments-only";
		readonly functions: readonly string[];
	} | null;
	readonly host: {
		readonly prefer: readonly ("herdr" | "tmux")[];
		readonly herdrWorkspace: string | null;
		readonly herdrSocket: string | null;
	};
};

/** Validated launch policy. Plain tasks cannot carry bundle runtime state. */
export type Mission = MissionPolicy & {
	readonly root: string;
	readonly configPath: string;
	readonly configHash: string;
} & (
	| {
		readonly task: { readonly kind: "plain"; readonly prompt: string };
		readonly bundle: null;
	}
	| {
		readonly task: { readonly kind: "bundle"; readonly prompt: string };
		readonly bundle: DeepReadonly<import("../bundle/types.js").RalphBundle> & {
			readonly itemKeys: readonly string[];
		};
	}
);

/** Watch item status. `stopped` means stopped without a newer blocker. */
export type ItemStatus = "passed" | "working" | "retry" | "blocked" | "stopped" | "pending";

/** A bundle item as currently observed in `.ralph/items.json`. */
export type ObservedItem = {
	readonly key: string;
	readonly index: number;
	readonly id: string | null;
	readonly title: string;
	readonly description: string;
	readonly passes: boolean;
	readonly regressionNotes: string;
	readonly status: ItemStatus;
};

/** A parsed progress card with commit evidence taken from git, never from `resolvedBy`. */
export type ObservedAttempt = import("./progress.js").AttemptCard & {
	/** Commit that introduced this passed entry and flipped its item. */
	readonly commitSha: string | null;
	/** For blocked cards: the pass commit of the resolving card. */
	readonly resolvedCommitSha: string | null;
};

/** Classification priority: item-pass, then blocker, then approved parent, then other. */
export type CommitEvent = {
	readonly sha: string;
	readonly parents: readonly string[];
	readonly subject: string;
	/** Null when the commit carries an invalid committer timestamp (reported as an issue). */
	readonly committedAt: string | null;
	readonly kind: "item-pass" | "blocker" | "parent" | "other";
	/** Item keys whose `passes` flipped false to true against the first parent. */
	readonly passedItems: readonly string[];
	/** Known item key captured by the configured blocker pattern. */
	readonly blockerItem: string | null;
	readonly parentReason: string | null;
	/** False when items.json at this commit or its first parent is invalid, or present in only one: a pass there is unknown. */
	readonly passesKnown: boolean;
};

/** A run start identified by token and original start time. */
export type RunStart = {
	readonly source: "state" | "journal";
	readonly loopToken: string;
	readonly startedAt: string;
};

export type GitObservation = {
	readonly head: string;
	readonly branch: string | null;
	readonly base: string | null;
	/** Commits in base..head, oldest first in topological order; null when unavailable. */
	readonly commits: readonly CommitEvent[] | null;
};

/**
 * One changed path in a seam. `skipped`: no generic rule reads this file's
 * content (not JS/TS and not a discovered test). `unavailable`: content needed
 * but not readable as text (binary, unmerged, not a regular file).
 */
export type FileChange = {
	readonly path: string;
	readonly status: "A" | "M" | "D" | "T" | "U";
	readonly content:
		| {
			readonly kind: "lines";
			/** Every line of the new side, so a construct may span into context lines. */
			readonly lines: readonly string[];
			/** Old side from the same whole-file diff; empty for an addition. */
			readonly oldLines: readonly string[];
			/** 1-based numbers of the added lines, ascending. */
			readonly added: readonly number[];
			/** Per line, for JS/TS files only. */
			readonly lexed: readonly import("./content.js").LexedLine[] | null;
		}
		| { readonly kind: "skipped" }
		| { readonly kind: "unavailable"; readonly reason: string };
};

export type DebtSide =
	| { readonly kind: "ok"; readonly value: Readonly<Record<string, number>> | readonly string[] }
	| { readonly kind: "absent" }
	| { readonly kind: "invalid"; readonly reason: string };
export type ItemsDiff = {
	readonly inserted: readonly string[];
	readonly removed: readonly string[];
	readonly unpassed: readonly string[];
	readonly passed: readonly string[];
	readonly edited: readonly { readonly key: string; readonly fields: readonly string[] }[];
	readonly beforePending: readonly string[];
	readonly documentEdited: boolean;
};
export type SeamPolicyEvidence = {
	/** Counts are collected only with configured thresholds; null means binary/unavailable. */
	readonly numstat: readonly { readonly path: string; readonly added: number | null; readonly removed: number | null }[];
	readonly items: ItemsDiff | { readonly unavailable: string } | null;
	readonly debt: Readonly<Record<string, { readonly before: DebtSide; readonly after: DebtSide }>>;
	readonly oldLines: Readonly<Record<string, readonly string[]>>;
};

export type SeamEvidence =
	| { readonly status: "fresh"; readonly changes: readonly FileChange[]; readonly policy: SeamPolicyEvidence }
	| { readonly status: "unavailable"; readonly error: string };

/**
 * Content evidence collected inside the consistent git window. Only present
 * when git is fresh. Commit seams are against the first parent; `index` is
 * HEAD->INDEX; `worktree` is INDEX->WORKTREE plus untracked files.
 */
export type ContentEvidence = {
	/** False only on proof (exit 1); null when unknown. */
	readonly baseAncestor: boolean | null;
	/** Per commit in history; a commit missing here has no evidence. */
	readonly commits: Readonly<Record<string, SeamEvidence>>;
	readonly index: SeamEvidence;
	readonly worktree: SeamEvidence;
};

/** Branch at launch, captured into the run spec (owner decision on #11). Null means detached HEAD. */
export type LaunchBaseline = { readonly branch: string | null };

/** `history` is the base..HEAD commit inspection, separate from HEAD/branch (`git`). */
export type SourceName = "state" | "items" | "progress" | "git" | "history" | "journal";

/**
 * One report shape for every source.
 * fresh: read completely and unchanged over the whole observation; may prove status.
 * retained: not fresh now; the last good value is in `retained` (display only).
 * unavailable: not fresh and nothing retained. `error` always carries the cause.
 * not-applicable: the task has no such source (plain task items/progress).
 */
export type SourceStatus = "fresh" | "retained" | "unavailable" | "not-applicable";
export type SourceReport = { readonly status: SourceStatus; readonly error: string | null };

type Retained<T> = { readonly value: T; readonly observedAt: string } | null;

/**
 * Last good values for sources that are not fresh in this snapshot. Display
 * only: retained data never proves a terminal state or a HARD alert.
 */
export type RetainedValues = {
	readonly state: Retained<import("../types.js").RalphLoopState>;
	readonly items: Retained<readonly ObservedItem[]>;
	readonly attempts: Retained<readonly ObservedAttempt[]>;
	readonly git: Retained<GitObservation>;
	readonly history: Retained<readonly CommitEvent[]>;
	readonly journal: Retained<JournalView>;
};

export type LoopSnapshot = {
	readonly root: string;
	readonly observedAt: string;
	readonly mission: Mission | null;
	readonly task: "bundle" | "plain" | null;
	readonly run: RunKey;
	/** Fresh valid state only; partial or missing state is null with an issue. */
	readonly state: import("../types.js").RalphLoopState | null;
	readonly items: readonly ObservedItem[];
	/** First not-passed item while the loop is running. */
	readonly currentItem: string | null;
	/** First not-passed item while the loop is stopped. */
	readonly stoppedItem: string | null;
	readonly attempts: readonly ObservedAttempt[];
	/** Per item key: unresolved blocked cards first, then newest file index first. */
	readonly itemAttempts: Readonly<Record<string, readonly ObservedAttempt[]>>;
	readonly runStarts: readonly RunStart[];
	/** True only when durable timing coverage is complete. */
	readonly historyComplete: boolean;
	readonly timeline: Timeline;
	readonly health: Health;
	/** Fresh, consistent git evidence; null when git failed or changed during the read. */
	readonly git: GitObservation | null;
	/** Content evidence from the same consistent window as `git`; null whenever `git` is null. */
	readonly evidence: ContentEvidence | null;
	readonly sources: Readonly<Record<SourceName, SourceReport>>;
	readonly retained: RetainedValues;
	readonly issues: readonly Issue[];
	/** Journal usage summed for the current loop token (owner Q4 on #15); null without fresh state and journal. */
	readonly usage: RunUsage | null;
	/** Fresh journal history only. Null means unavailable, not empty history. */
	readonly iterations: readonly IterationEntry[] | null;
};

export type LoopReader = {
	read(signal?: AbortSignal): Promise<LoopSnapshot>;
	close(): Promise<void>;
};

export type Usage = { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
/** Token and cost totals of one run. */
export type RunUsage = Usage & { readonly costUsd: number };
export type IterationTotals = Usage & { readonly costUsd: number; readonly messages: number; readonly dialogsCancelled: number; readonly refusals: number };
export type ToolEntry = {
	readonly id: string;
	readonly name: string;
	readonly label: string;
	readonly startedAt: string | null;
} & (
	| { readonly endedAt: null }
	| { readonly endedAt: string; readonly ms: number | null; readonly error: boolean }
);
export type DriverCounters = { readonly dialogsCancelled: number; readonly refusals: number; readonly badRecords: number; readonly badFacts: number; readonly subscriberDrops: number };
export type DriverEvent =
	| { readonly kind: "tool-start" | "tool-end"; readonly tool: ToolEntry }
	| { readonly kind: "assistant-end"; readonly usage: Usage; readonly costUsd: number; readonly stopReason: string | null; readonly model: string | null }
	| { readonly kind: "message"; readonly text: string }
	| { readonly kind: "activity" }
	| { readonly kind: "dialog-cancelled"; readonly method: string; readonly title: string | null }
	| { readonly kind: "refusal"; readonly tool: string; readonly text: string }
	| { readonly kind: "fact"; readonly fact: import("../loop/watch-events.js").LoopFact };
export type DriverState = "starting" | "ready" | "launched" | "closing";
export type ControlOp = "stop" | "steer" | "go";
export type EventFrame =
	| { readonly v: 1; readonly type: "hello"; readonly launchId: string; readonly pid: number; readonly nextSeq: number; readonly lastPiAt: string | null; readonly loop: { readonly token: string; readonly startedAt: string; readonly iteration: number } | null; readonly tools: readonly ToolEntry[]; readonly totals: IterationTotals; readonly counters: DriverCounters; readonly state: DriverState }
	| ({ readonly v: 1; readonly seq: number; readonly at: string } & (
		| { readonly type: "event"; readonly event: DriverEvent }
		| { readonly type: "gap"; readonly source: "facts"; readonly from: number; readonly to: number }
		| { readonly type: "lifecycle"; readonly state: "ready" | "launched" | "launch-failed" | "pi-exited" | "closed"; readonly code?: number | null; readonly detail?: string }
		| { readonly type: "ack"; readonly id: string; readonly op: ControlOp; readonly phase: "accepted" | "completed" | "rejected"; readonly reason?: string; readonly duplicate?: boolean }
	));

export const DRIVER_JOURNAL_EVENTS = ["start", "ready", "launched", "gate-wait", "pi-not-ready", "pi-exit", "gap", "exit"] as const;
type JournalBase = { readonly v: 1; readonly t: string; readonly r: string };
/** Only non-derivable facts belong in the bounded operator journal. */
export type JournalRecord = JournalBase & (
	| { readonly k: "run"; readonly m: string; readonly th: string; readonly mx: number; readonly tk: "b" | "p" }
	| { readonly k: "loop"; readonly tok: string; readonly sa: string; readonly i: number; readonly ph: "initialized" | "resumed" }
	| { readonly k: "g"; readonly tok: string; readonly i: number; readonly p: import("../loop/control-promise.js").ControlPromise; readonly ok: 0 | 1; readonly why?: string }
	| { readonly k: "u"; readonly tok: string | null; readonly i: number; readonly in: number; readonly out: number; readonly cr: number; readonly cw: number; readonly c: number; readonly n: number; readonly dc: number; readonly pr: number }
	| { readonly k: "x"; readonly op: "stop" | "steer"; readonly id: string | null; readonly ok: 0 | 1; readonly why?: string; readonly txt?: string; readonly part?: number }
	| { readonly k: "d"; readonly e: (typeof DRIVER_JOURNAL_EVENTS)[number]; readonly c?: number | null; readonly why?: string }
);

export type JournalView = {
	readonly records: readonly JournalRecord[];
	readonly launches: readonly { readonly launchId: string; readonly at: string }[];
	readonly runs: readonly RunStart[];
	readonly stops: readonly { readonly at: string; readonly launchId: string; readonly kind: "exit" | "pi-exit" }[];
	readonly badLines: number;
	readonly rotated: boolean;
	readonly coverageStart: string | null;
};
export type Boundary = { readonly at: string; readonly kind: "run-start" | "item-pass" | "blocker" | "parent"; readonly sha: string | null; readonly item: string | null };
export type Span = { readonly from: string; readonly to: string | null; readonly known: boolean };
export type Duration = { readonly ms: number; readonly from: string; readonly to: string; readonly sha: string } | { readonly ms: null; readonly reason: string };
export type Timeline = {
	readonly coverage: { readonly start: string | null; readonly complete: boolean; readonly reason: string | null };
	readonly boundaries: readonly Boundary[];
	readonly stopped: readonly Span[];
	readonly elapsed: { readonly wallMs: number; readonly activeMs: number | null } | null;
	readonly currentItem: { readonly key: string; readonly since: Boundary; readonly ms: number } | { readonly key: string; readonly ms: null; readonly reason: string } | null;
	readonly durations: Readonly<Record<string, Duration>>;
	readonly eta: { readonly estimateMs: number | null; readonly n: number; readonly itemsLeft: number };
};
export type Counter = { readonly value: number; readonly previous: number | null; readonly rising: boolean };
export type Health = {
	readonly state: "running" | "stale" | "stopped" | "not-started" | "unknown";
	readonly heartbeatAgeMs: number | null;
	readonly stale: boolean | null;
	readonly stopped: { readonly reason: string | null; readonly at: string | null } | null;
	readonly lastJournalAt: string | null;
	readonly stalled: "unavailable";
	/** Null when state is not fresh; retained counters never feed comparisons. */
	readonly counters: { readonly errors: Counter; readonly bundleRejections: Counter } | null;
};

/** Operator timeline: marks denote exceptions, never successful gates. */
export type IterationEntry =
	| { readonly kind: "run"; readonly at: string; readonly token: string; readonly phase: "initialized" | "resumed" }
	| { readonly kind: "intervention"; readonly at: string; readonly op: "stop" | "steer"; readonly accepted: boolean; readonly reason: string | null }
	| { readonly kind: "gate"; readonly at: string; readonly iteration: number; readonly promise: import("../loop/control-promise.js").ControlPromise; readonly item: string | null; readonly commit: string | null; readonly accepted: boolean; readonly reason: string | null; readonly marks: readonly ("rejection" | "enforcer")[] }
	| { readonly kind: "parent"; readonly at: string; readonly commit: string; readonly reason: string | null }
	| { readonly kind: "incomplete"; readonly at: string; readonly reason: string };
