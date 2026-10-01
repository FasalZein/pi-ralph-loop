import path from "node:path";

import type { Mission } from "./types.js";

/** Owner decision on #11 (2026-10-01): suppression comments are token based in these files only. */
export const JS_TS_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export const isJsTs = (file: string): boolean => JS_TS_EXTENSIONS.includes(path.posix.extname(file).toLowerCase());

/** Test discovery from mission scope. No configured discovery matches nothing; there is no default test root. */
export function isTestPath(mission: Mission | null, file: string): boolean {
	if (!mission) return false;
	const { testGlobs, testRegex } = mission.scope;
	return testGlobs.some((glob) => path.posix.matchesGlob(file, glob)) || (testRegex !== null && new RegExp(testRegex).test(file));
}

/** A JS/TS line split into code (string and regex bodies blanked) and its comment segments. */
export type LexedLine = { readonly code: string; readonly comments: readonly string[] };

const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/**
 * Classify every character of a JS/TS file as code, comment or literal. The
 * whole file is scanned so a line inside a multi-line block comment or
 * template is classified correctly. A regex literal or a quoted string ends at
 * a newline (error recovery), so a misread `/` damages one line only.
 */
export function lexLines(text: string): LexedLine[] {
	const CODE = 0, COMMENT = 1, LITERAL = 2;
	const kinds = new Uint8Array(text.length);
	type Mode = "code" | "line" | "block" | "sq" | "dq" | "tpl" | "re" | "reclass";
	let mode: Mode = "code";
	// Template nesting: each entry is the brace depth at which `${` resumes the template.
	const templates: number[] = [];
	let depth = 0;
	let lastSignificant = "";
	let lastWord = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const next = text[i + 1];
		switch (mode) {
			case "code": {
				if (c === "/" && next === "/") { mode = "line"; kinds[i] = COMMENT; continue; }
				if (c === "/" && next === "*") { mode = "block"; kinds[i] = kinds[i + 1] = COMMENT; i++; continue; }
				if (c === "'" || c === '"' || c === "`") { mode = c === "'" ? "sq" : c === '"' ? "dq" : "tpl"; kinds[i] = LITERAL; lastSignificant = c; lastWord = ""; continue; }
				if (c === "/" && (lastSignificant === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant) || REGEX_AFTER_WORD.has(lastWord))) {
					mode = "re"; kinds[i] = LITERAL; continue;
				}
				kinds[i] = CODE;
				if (c === "{") depth++;
				if (c === "}") {
					if (templates.length && templates[templates.length - 1] === depth) { templates.pop(); depth--; mode = "tpl"; kinds[i] = LITERAL; lastSignificant = "`"; continue; }
					depth--;
				}
				if (/\s/.test(c)) continue;
				if (/[\w$]/.test(c)) lastWord = /[\w$]/.test(lastSignificant) ? lastWord + c : c;
				else lastWord = "";
				lastSignificant = c;
				continue;
			}
			case "line":
				if (c === "\n") { mode = "code"; kinds[i] = CODE; } else kinds[i] = COMMENT;
				continue;
			case "block":
				kinds[i] = c === "\n" ? CODE : COMMENT;
				if (c === "*" && next === "/") { kinds[i + 1] = COMMENT; i++; mode = "code"; }
				continue;
			case "sq": case "dq": case "re": case "reclass": {
				if (c === "\n") { mode = "code"; kinds[i] = CODE; lastSignificant = ""; continue; }
				kinds[i] = LITERAL;
				if (c === "\\") { if (next !== "\n") kinds[++i] = LITERAL; continue; }
				if ((mode === "sq" && c === "'") || (mode === "dq" && c === '"')) { mode = "code"; lastSignificant = c; lastWord = ""; }
				else if (mode === "re" && c === "[") mode = "reclass";
				else if (mode === "reclass" && c === "]") mode = "re";
				else if (mode === "re" && c === "/") { mode = "code"; lastSignificant = ")"; lastWord = ""; }
				continue;
			}
			case "tpl":
				kinds[i] = c === "\n" ? CODE : LITERAL;
				if (c === "\\") { if (next !== undefined) kinds[++i] = LITERAL; continue; }
				if (c === "`") { mode = "code"; lastSignificant = "`"; lastWord = ""; }
				else if (c === "$" && next === "{") { kinds[++i] = LITERAL; depth++; templates.push(depth); mode = "code"; lastSignificant = "{"; lastWord = ""; }
				continue;
		}
	}
	const lines: LexedLine[] = [];
	let start = 0;
	for (let end = 0; end <= text.length; end++) {
		if (end < text.length && text[end] !== "\n") continue;
		let code = "";
		const comments: string[] = [];
		let comment = "";
		for (let i = start; i < end; i++) {
			code += kinds[i] === CODE ? text[i] : " ";
			if (kinds[i] === COMMENT) comment += text[i];
			else if (comment) { comments.push(comment); comment = ""; }
		}
		if (comment) comments.push(comment);
		lines.push({ code, comments });
		start = end + 1;
	}
	return lines;
}
