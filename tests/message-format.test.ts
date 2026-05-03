/**
 * Tests for message-format.ts — AI injection message formatting
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDiffMessage, formatCommentsMessage } from "../message-format.js";
import type { DiffFile, DiffHunk } from "../diff-parser.js";

function makeHunk(header: string, lines: string[]): DiffHunk {
  return { id: 0, header, lines: [header, ...lines], selected: true };
}

function makeFile(path: string, comment?: string): DiffFile {
  return {
    path,
    stats: { added: 0, removed: 0 },
    hunks: [],
    reviewed: true,
    stale: false,
    justReviewed: false,
    currentHash: "abc",
    comment,
    fileType: "modified" as const,
  };
}

describe("formatDiffMessage", () => {
  it("formats single hunk with question", () => {
    const result = formatDiffMessage({
      hunks: [makeHunk("@@ -1,3 +1,4 @@", ["+added"])],
      files: ["src/foo.ts"],
      question: "why this?",
      target: "main...HEAD",
    });
    assert.ok(result.includes("[Diff Review — 1 hunk, 1 file]"));
    assert.ok(result.includes("File: src/foo.ts"));
    assert.ok(result.includes("+added"));
    assert.ok(result.includes("why this?"));
  });

  it("formats multiple hunks", () => {
    const result = formatDiffMessage({
      hunks: [makeHunk("@@ -1,3 +1,4 @@", ["+a"]), makeHunk("@@ -10,2 +11,2 @@", ["-b", "+c"])],
      files: ["x.ts"],
      question: "review pls",
      target: "HEAD~5",
    });
    assert.ok(result.includes("2 hunks"));
    assert.ok(result.includes("-b"));
  });
});

describe("formatCommentsMessage", () => {
  it("returns empty for no comments", () => {
    assert.strictEqual(
      formatCommentsMessage("main...HEAD", [makeFile("a.ts"), makeFile("b.ts")]),
      "",
    );
  });
  it("formats comments from multiple files", () => {
    const result = formatCommentsMessage("main...HEAD", [
      makeFile("a.ts", "looks good"),
      makeFile("b.ts", "needs work"),
    ]);
    assert.ok(result.includes("a.ts:"));
    assert.ok(result.includes("  looks good"));
    assert.ok(result.includes("b.ts:"));
  });
});
