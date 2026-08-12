const OPT_OUT_ENV = "RALPH_LIMIT_REMINDERS_DISABLED";

const LIMIT_REMINDERS = [
	{
		id: "75",
		percent: 75,
		message:
			"Your context window in this Pi session is 75% full. Do not expand scope or begin optional work. Focus on completing the current iteration.",
	},
	{
		id: "80",
		percent: 80,
		message:
			"Your context window in this Pi session is 80% full. Finish the current work now. Do not open new lines of work. Reserve the remaining context for concluding the iteration.",
	},
	{
		id: "85",
		percent: 85,
		message:
			"Your context window in this Pi session is 85% full. Stop task work now. Perform only the end-of-iteration steps required by the original instructions, then emit <promise>NEXT</promise> if valid. Do not continue implementation to make it valid, and do not claim unfinished work.",
	},
] as const;

export function areLimitRemindersDisabled(): boolean {
	const value = process.env[OPT_OUT_ENV];
	return value !== undefined && value !== "" && value !== "0";
}

export type SelectedReminder = {
	message: string;
	/** The updated comma-separated set of sent reminder ids to persist. */
	sentCsv: string;
};

/**
 * Select the next context-limit reminder to send, given the current usage
 * percent and the comma-separated ids already sent this iteration. Returns null
 * when no new reminder applies. Each reminder fires at most once per iteration.
 */
export function selectLimitReminder(
	usagePercent: number,
	sentCsv: string | null,
): SelectedReminder | null {
	const sent = new Set(
		(sentCsv ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean),
	);
	let reminder: (typeof LIMIT_REMINDERS)[number] | undefined;
	for (let index = LIMIT_REMINDERS.length - 1; index >= 0; index--) {
		const candidate = LIMIT_REMINDERS[index];
		if (usagePercent >= candidate.percent && !sent.has(candidate.id)) {
			reminder = candidate;
			break;
		}
	}
	if (!reminder) return null;

	for (const candidate of LIMIT_REMINDERS) {
		if (candidate.percent <= reminder.percent) sent.add(candidate.id);
	}
	const updatedSentCsv = LIMIT_REMINDERS.filter((candidate) => sent.has(candidate.id))
		.map((candidate) => candidate.id)
		.join(",");
	return { message: reminder.message, sentCsv: updatedSentCsv };
}
