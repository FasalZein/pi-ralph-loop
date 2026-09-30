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
