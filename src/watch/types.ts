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
