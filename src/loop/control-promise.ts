export type ControlPromise = "NEXT" | "COMPLETE" | "STOP" | "WAIT";

// Markdown code-fence delimiters (``` or ~~~, optional language tag) are
// presentation, not content. Models routinely wrap the control tag in a fenced
// block; without this, the closing fence becomes the "last non-empty line" and
// hides a valid NEXT/COMPLETE/STOP/WAIT from the loop. Drop delimiter lines
// before picking the terminal line so a fenced tag reads the same as a plain or
// inline-code tag. Prose after the fence still wins, matching the contract that
// the last non-empty line is the handoff.
const FENCE_DELIMITER = /^(`{3,}|~{3,})\s*[\w.-]*$/;

export function extractControlPromise(
	msg: { content?: unknown } | null,
): ControlPromise | null {
	if (!msg || !Array.isArray(msg.content)) return null;

	const text = (msg.content as Array<{ type: string; text?: string }>)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n")
		.trim();
	if (!text) return null;

	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => !FENCE_DELIMITER.test(line) && line.length > 0);
	if (lines.length === 0) return null;

	const finalLine = lines[lines.length - 1].replace(/^`+|`+$/g, "");
	const match = finalLine.match(/<promise>(NEXT|COMPLETE|STOP|WAIT)<\/promise>$/);
	return match ? (match[1] as ControlPromise) : null;
}
