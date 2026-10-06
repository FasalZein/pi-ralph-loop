import { grammarOf, isJsTs, lexLines } from "./content.js";
import type { FileChange } from "./types.js";

/** Git v2.52.0 xdiff-interface.c: FIRST_FEW_BYTES in buffer_is_binary().
 * https://github.com/git/git/blob/v2.52.0/xdiff-interface.c#L197-L202
 */
export const GIT_BINARY_SNIFF_BYTES = 8000;

export function textContent(rel: string, sparse: readonly string[], added: readonly number[], oldLines: readonly string[] = []): FileChange["content"] {
	const lines = Array.from(sparse, line => line ?? "");
	return { kind: "lines", lines, oldLines, added, lexed: isJsTs(rel) ? lexLines(lines.join("\n"), grammarOf(rel)) : null };
}

/** One whole-file unified-diff parser supplies both generic and policy evidence. */
export function parseDiff(rel: string, out: string): FileChange["content"] {
	const rows = out.split("\n"), added: number[] = [], lines: string[] = [], oldLines: string[] = [];
	let hunk = false, seenHunk = false, n = 0, old = 0;
	for (const row of rows) {
		const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
		if (header) { hunk = seenHunk = true; old = Number(header[1]); n = Number(header[2]); continue; }
		if (!hunk) continue;
		if (row.startsWith("+")) { added.push(n); lines[n - 1] = row.slice(1); n++; }
		else if (row.startsWith("-")) { oldLines[old - 1] = row.slice(1); old++; }
		else if (row.startsWith(" ")) { lines[n - 1] = oldLines[old - 1] = row.slice(1); n++; old++; }
		else if (!row.startsWith("\\")) hunk = false;
	}
	if (!seenHunk && rows.some(row => row.startsWith("Binary files ") || row === "GIT binary patch")) return { kind: "unavailable", reason: "binary" };
	return textContent(rel, lines, added, Array.from(oldLines, line => line ?? ""));
}
