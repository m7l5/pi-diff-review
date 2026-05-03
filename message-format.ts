/**
 * Message formatters — format diff hunks and comments for AI injection.
 * Pure functions, fully testable.
 */

import type { DiffFile, DiffHunk } from "./diff-parser.js";

export type ReviewResult = {
  hunks: DiffHunk[];
  files: string[];
  question: string;
  target: string;
};

/**
 * Format selected hunks + user question into a message for the AI.
 */
export function formatDiffMessage(result: ReviewResult): string {
  const header = `[Diff Review — ${result.hunks.length} hunk${result.hunks.length !== 1 ? "s" : ""}, ${result.files.length} file${result.files.length !== 1 ? "s" : ""}]`;
  const parts: string[] = [header, ""];

  // Group hunks by file
  const byFile = new Map<string, DiffHunk[]>();
  for (const h of result.hunks) {
    const file = result.files.length === 1 ? result.files[0] : "unknown";
    if (!file) continue;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(h);
  }

  for (const [file, hunks] of byFile) {
    parts.push(`File: ${file}`);
    for (const h of hunks) {
      parts.push(h.header);
      for (const l of h.lines.slice(1)) {
        if (l.length > 0 || h.lines.indexOf(l) !== h.lines.length - 1) {
          parts.push(l);
        }
      }
    }
    parts.push("");
  }

  parts.push("---");
  parts.push("");
  parts.push(result.question);
  return parts.join("\n");
}

/**
 * Format all file comments into a compiled summary message for the AI.
 */
export function formatCommentsMessage(target: string, files: DiffFile[]): string {
  const parts = [`[Diff Review — Compiled Comments — ${target}]`, ""];
  let hasAny = false;
  for (const f of files) {
    if (f.comment) {
      parts.push(`${f.path}:`);
      parts.push(`  ${f.comment}`);
      parts.push("");
      hasAny = true;
    }
    if (f.hunkComments) {
      for (const hc of f.hunkComments) {
        const lineInfo = hc.startLine > 0 ? ` (L${hc.startLine}-${hc.endLine})` : "";
        parts.push(`${f.path}${lineInfo}:`);
        parts.push(`  ${hc.text}`);
        parts.push("");
        hasAny = true;
      }
    }
  }
  return hasAny ? parts.join("\n") : "";
}
