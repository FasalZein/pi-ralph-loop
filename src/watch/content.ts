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

/**
 * One line of a JS/TS file, split by character class. Every string has the
 * line's length: `code` keeps code characters, `comment` keeps comment
 * characters, and other positions are spaces. `unsure` has `?` where the
 * lexer cannot classify with certainty (JSX, an ambiguous `/` or `<`).
 */
export type LexedLine = { readonly code: string; readonly comment: string; readonly unsure: string };

/** Extensions in which JSX syntax is valid; plain TS and its module variants do not allow it. */
const JSX_EXTENSIONS: readonly string[] = [".tsx", ".jsx", ".js", ".mjs", ".cjs"];
export const allowsJsx = (file: string): boolean => JSX_EXTENSIONS.includes(path.posix.extname(file).toLowerCase());

const EXPRESSION_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const CONTROL_PAREN_WORDS = new Set(["if", "while", "for", "with"]);
const EXPRESSION_AFTER_PUNCT = "(,=:[!&|?{};+-*%<>~^.";

/**
 * Classify every character of a JS/TS file as code, comment or literal. The
 * whole file is scanned, so a line inside a multi-line comment, string or
 * template is classified correctly. Where a `/` or `<` cannot be classified
 * without a parser (after `}`), or inside JSX, characters are marked unsure
 * until the lexer is back in top-level code at a line start. An unsure
 * position never proves a comment or a call.
 */
export function lexLines(text: string, jsx: boolean): LexedLine[] {
	const CODE = 0, COMMENT = 1, LITERAL = 2;
	const kinds = new Uint8Array(text.length);
	const unsure = new Uint8Array(text.length);
	type Mode = "code" | "line" | "block" | "sq" | "dq" | "tpl" | "re" | "reclass" | "jsxtag" | "jsxattr" | "jsxtext";
	type Frame = { readonly depth: number; readonly resume: "tpl" | "jsxtag" | "jsxtext"; readonly jsxDepth: number };
	let mode: Mode = "code";
	const frames: Frame[] = [];
	// One entry per open `(`: true when it opens a control-statement condition, after which `/` starts a regex.
	const parens: boolean[] = [];
	let depth = 0;
	let jsxDepth = 0;
	let closingTag = false;
	let attrQuote = "";
	// Whether an expression may start here: a `/` then opens a regex, a `<` JSX. "unknown" after `}`.
	let expression: boolean | "unknown" = true;
	let word = "";
	let wordAfterDot = false;
	let previous = "";
	let taint = false;
	const literal = (i: number) => { kinds[i] = LITERAL; };
	for (let i = 0; i < text.length; i++) {
		// Uncertainty ends only at a line start in top-level code.
		if (taint && i > 0 && text[i - 1] === "\n" && mode === "code" && frames.length === 0) taint = false;
		if (taint) unsure[i] = 1;
		const c = text[i];
		const next = text[i + 1];
		switch (mode) {
			case "code": {
				if (c === "/" && next === "/") { mode = "line"; kinds[i] = COMMENT; continue; }
				if (c === "/" && next === "*") { mode = "block"; kinds[i] = kinds[i + 1] = COMMENT; if (taint) unsure[i + 1] = 1; i++; continue; }
				if (c === "'" || c === '"' || c === "`") { mode = c === "'" ? "sq" : c === '"' ? "dq" : "tpl"; literal(i); word = ""; continue; }
				if (c === "/" && expression !== false) {
					if (expression === "unknown") { taint = true; unsure[i] = 1; }
					mode = "re"; literal(i); continue;
				}
				if (jsx && c === "<" && expression !== false && next !== undefined && /[A-Za-z_$>]/.test(next)) {
					if (expression === "unknown") taint = true;
					mode = "jsxtag"; closingTag = false; jsxDepth = 0; literal(i); unsure[i] = 1; continue;
				}
				kinds[i] = CODE;
				if (/\s/.test(c)) continue;
				if (c === "{") depth++;
				if (c === "}") {
					const top = frames[frames.length - 1];
					if (top && top.depth === depth) {
						frames.pop(); depth--; mode = top.resume; jsxDepth = top.jsxDepth; literal(i);
						if (top.resume !== "tpl") unsure[i] = 1;
						continue;
					}
					depth--;
				}
				if (/[\w$]/.test(c)) {
					if (!/[\w$]/.test(text[i - 1] ?? "")) { wordAfterDot = previous === "."; word = ""; }
					word += c;
					expression = !wordAfterDot && EXPRESSION_AFTER_WORD.has(word);
				} else {
					if (c === "(") parens.push(!wordAfterDot && CONTROL_PAREN_WORDS.has(word));
					word = "";
					if (c === ")") expression = parens.pop() === true;
					else if (c === "]") expression = false;
					else if (c === "}") expression = "unknown";
					// Postfix `++`/`--` ends an operand.
					else if ((c === "+" || c === "-") && text[i - 1] === c) expression = false;
					else expression = EXPRESSION_AFTER_PUNCT.includes(c);
				}
				previous = c;
				continue;
			}
			case "line":
				if (c === "\n") mode = "code"; else kinds[i] = COMMENT;
				continue;
			case "block":
				if (c !== "\n") kinds[i] = COMMENT;
				if (c === "*" && next === "/") { kinds[i + 1] = COMMENT; if (taint) unsure[i + 1] = 1; i++; mode = "code"; }
				continue;
			case "sq": case "dq": {
				if (c === "\n") { mode = "code"; expression = false; previous = ""; continue; }
				literal(i);
				if (c === "\\") {
					// A line continuation keeps the string open on the next line.
					const skip = next === "\r" && text[i + 2] === "\n" ? 2 : 1;
					for (let k = 1; k <= skip && i + 1 < text.length; k++) { literal(++i); if (taint) unsure[i] = 1; }
					continue;
				}
				if ((mode === "sq" && c === "'") || (mode === "dq" && c === '"')) { mode = "code"; expression = false; previous = c; }
				continue;
			}
			case "re": case "reclass": {
				if (c === "\n") { mode = "code"; expression = false; previous = ""; continue; }
				literal(i);
				if (c === "\\") { if (next !== "\n") { literal(++i); if (taint) unsure[i] = 1; } continue; }
				if (mode === "re" && c === "[") mode = "reclass";
				else if (mode === "reclass" && c === "]") mode = "re";
				else if (mode === "re" && c === "/") { mode = "code"; expression = false; previous = c; }
				continue;
			}
			case "tpl":
				if (c !== "\n") literal(i);
				if (c === "\\") { if (next !== undefined) { literal(++i); if (taint) unsure[i] = 1; } continue; }
				if (c === "`") { mode = "code"; expression = false; previous = c; }
				else if (c === "$" && next === "{") { literal(++i); if (taint) unsure[i] = 1; frames.push({ depth: ++depth, resume: "tpl", jsxDepth }); mode = "code"; expression = true; previous = "{"; word = ""; }
				continue;
			case "jsxtag": case "jsxattr": case "jsxtext": {
				unsure[i] = 1;
				if (c !== "\n") literal(i);
				if (mode === "jsxattr") { if (c === attrQuote) mode = "jsxtag"; continue; }
				if (c === "{") {
					frames.push({ depth: ++depth, resume: mode, jsxDepth });
					jsxDepth = 0; mode = "code"; expression = true; previous = "{"; word = "";
					continue;
				}
				if (mode === "jsxtext") {
					if (c === "<") mode = "jsxtag", closingTag = false;
					continue;
				}
				if (c === "/" && text[i - 1] === "<") { closingTag = true; continue; }
				if (c === '"' || c === "'") { mode = "jsxattr"; attrQuote = c; continue; }
				const selfClosing = c === "/" && next === ">";
				if (selfClosing || c === ">") {
					if (selfClosing) { i++; unsure[i] = 1; literal(i); }
					else jsxDepth += closingTag ? -1 : 1;
					if (jsxDepth <= 0) { mode = "code"; expression = false; previous = ">"; word = ""; } else mode = "jsxtext";
				}
				continue;
			}
		}
	}
	const lines: LexedLine[] = [];
	let start = 0;
	for (let end = 0; end <= text.length; end++) {
		if (end < text.length && text[end] !== "\n") continue;
		let code = "", comment = "", mask = "";
		for (let i = start; i < end; i++) {
			code += kinds[i] === CODE ? text[i] : " ";
			comment += kinds[i] === COMMENT ? text[i] : " ";
			mask += unsure[i] ? "?" : " ";
		}
		lines.push({ code, comment, unsure: mask });
		start = end + 1;
	}
	return lines;
}
