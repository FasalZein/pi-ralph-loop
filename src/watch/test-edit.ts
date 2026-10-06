import { grammarOf, lexLines } from "./content.js";

/** Conservative exception: keep every byte outside the configured calls' arguments. */
export function argumentsOnly(file: string, before: readonly string[], after: readonly string[], functions: readonly string[]): boolean {
	const skeleton = (lines: readonly string[]): string | null => {
		const raw = lines.join("\n"), lexed = lexLines(raw, grammarOf(file));
		if (lexed.some(line => line.unsure.includes("?"))) return null;
		const code = lexed.map(line => line.code).join("\n");
		let result = "", from = 0, calls = 0;
		for (const match of code.matchAll(/[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/g)) {
			if (match.index < from || !functions.includes(match[0].slice(0, -1).replace(/\s/g, ""))) continue;
			// A function or method declaration is not a call.
			if (/\bfunction\s*$/.test(code.slice(0, match.index))) continue;
			const open = match.index + match[0].length - 1;
			let depth = 1, close = open + 1;
			for (; close < code.length && depth; close++) { if (code[close] === "(") depth++; else if (code[close] === ")") depth--; }
			if (depth || /^\s*\{/.test(code.slice(close))) continue;
			result += raw.slice(from, open + 1) + "<arguments>";
			from = close - 1; calls++;
		}
		return calls ? result + raw.slice(from) : null;
	};
	const old = skeleton(before), now = skeleton(after);
	return old !== null && old === now;
}
