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
};

/** A run start. Sources other than loop.md (the journal) are a later seam. */
export type RunStart = {
	readonly source: "state";
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

export type SourceName = "state" | "items" | "progress" | "git";

/**
 * fresh: read completely and unchanged over the whole observation.
 * stale: not fresh now; the last good value is in `retained`.
 * missing: the file is absent. unavailable: not fresh and nothing retained.
 * not-applicable: the task has no such source (plain task items/progress).
 */
export type SourceStatus = "fresh" | "stale" | "missing" | "unavailable" | "not-applicable";

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
	/** False until durable run history (journal) exists; only starts seen by this reader are listed. */
	readonly historyComplete: false;
	/** Fresh, consistent git evidence; null when git failed or changed during the read. */
	readonly git: GitObservation | null;
	readonly sources: Readonly<Record<SourceName, SourceStatus>>;
	readonly retained: RetainedValues;
	readonly issues: readonly Issue[];
};

export type LoopReader = {
	read(signal?: AbortSignal): Promise<LoopSnapshot>;
	close(): Promise<void>;
};
