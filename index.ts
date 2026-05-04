/**
 * /diff-review — Interactive git diff review inside Pi
 *
 * Opens a full-screen TUI overlay showing git diff <target> organized by file
 * and hunk. Check files as reviewed, leave hunk-level comments, and compile
 * review notes into the Pi conversation.
 *
 * Usage:
 *   /diff-review                    → git diff HEAD in current Pi folder
 *   /diff-review HEAD...main        → git diff HEAD...main
 *   /diff-review origin/main        → git diff origin/main
 *   /diff-review HEAD~5             → git diff HEAD~5
 *   /diff-review feat/branch        → git diff feat/branch
 *   /diff-review --cached           → git diff --cached
 *   /diff-review ~/other-repo       → git diff HEAD in another repo
 *   /diff-review ~/repo origin/main → git diff origin/main in another repo
 *   /diff-review ~/repo HEAD~2...origin/main
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { DiffFile, DiffHunk } from "./diff-parser.js";
import { parseDiff } from "./diff-parser.js";
import type { ReviewResult } from "./message-format.js";
import { formatCommentsMessage } from "./message-format.js";
import { slugify, statePath } from "./state.js";
import { LspClient } from "./lsp-client.js";
import { DefinitionOverlay } from "./lsp-overlay.js";

// ─── Internal Types ───────────────────────────────────────

type ReviewedEntry = {
  hash: string;
  reviewedAt: string;
  comment?: string;
  comments?: { hunkStart: number; hunkEnd: number; text: string }[];
};

type ReviewState = {
  target: string;
  updatedAt: string;
  diffHash: string;
  reviewed: Record<string, ReviewedEntry>;
};

type Mode = "review" | "comment" | "compile";

type CompileComment =
  | { file: DiffFile; kind: "file"; text: string }
  | {
      file: DiffFile;
      kind: "hunk";
      index: number;
      text: string;
      startLine: number;
      endLine: number;
    };

// ─── Git Helpers ─────────────────────────────────────────

function resolvePath(raw: string, cwd: string): string {
  // Expand ~ and ~user
  if (raw.startsWith("~")) {
    const rest = raw.slice(1);
    if (rest === "" || rest.startsWith("/")) {
      return join(homedir(), rest.replace(/^\//, ""));
    }
    // ~user notation — not common, resolve relative to parent of user home
    return join(homedir(), "..", rest);
  }
  // Absolute path
  if (raw.startsWith("/")) return raw;
  // Relative path — resolve from cwd
  return join(cwd, raw);
}

type ParsedArgs = { target: string; repoPath?: string };

function parseCommandArgs(rawArgs: string, cwd: string): ParsedArgs {
  if (!rawArgs) return { target: "HEAD" };

  const firstMatch = rawArgs.match(/^(\S+)(?:\s+(.+))?$/);
  if (firstMatch) {
    const first = firstMatch[1];
    const rest = firstMatch[2]?.trim();
    const firstPath = first.startsWith("@") ? first.slice(1) : first;
    const repoPath = resolvePath(firstPath, cwd);
    if (gitRoot(repoPath)) {
      return { target: rest || "HEAD", repoPath };
    }
  }

  // Legacy syntax: "<diff-target> @<repo-path>". Keep this for existing users,
  // but only split on whitespace + @ so refs like stash@{0} remain valid targets.
  const legacyMatch = rawArgs.match(/^(.*?)\s+@(.+)$/);
  if (legacyMatch) {
    return {
      target: legacyMatch[1].trim() || "HEAD",
      repoPath: resolvePath(legacyMatch[2].trim(), cwd),
    };
  }

  return { target: rawArgs };
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function readFileLines(filePath: string, repoDir: string): string[] | null {
  try {
    // Try working tree first, fall back to git show HEAD
    const absPath = join(repoDir, filePath);
    if (existsSync(absPath)) {
      return splitLines(readFileSync(absPath, "utf-8"));
    }
    // Deleted file — show from HEAD
    return splitLines(
      execSync(`git show HEAD:"${filePath}" 2>/dev/null`, {
        encoding: "utf-8",
        cwd: repoDir,
      }),
    );
  } catch {
    return null;
  }
}

function isBinaryFile(filePath: string, repoDir: string): boolean {
  try {
    const bytes = readFileSync(join(repoDir, filePath));
    const sample = bytes.subarray(0, Math.min(bytes.length, 8000));
    if (sample.includes(0)) return true;

    let controlBytes = 0;
    for (const byte of sample) {
      if ((byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127) {
        controlBytes++;
      }
    }
    return sample.length > 0 && controlBytes / sample.length > 0.1;
  } catch {
    return false;
  }
}

type DisplayLine = {
  text: string;
  type: "addition" | "removal" | "context" | "gap" | "hunkHeader";
  hunkId?: number;
  lineNo?: number;
};

function gitRoot(cwd?: string): string | null {
  try {
    const opts = cwd ? { encoding: "utf-8" as const, cwd } : { encoding: "utf-8" as const };
    return execSync("git rev-parse --show-toplevel", opts).trim();
  } catch {
    return null;
  }
}

function gitDiff(target: string, cwd?: string): string {
  const opts: { encoding: "utf-8"; maxBuffer: number; cwd?: string; stdio: "pipe" } = {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: "pipe",
  };
  if (cwd) opts.cwd = cwd;
  return execSync(`git diff ${target}`, opts);
}

function gitErrorMessage(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string }).stderr;
  const stdout = (error as { stdout?: Buffer | string }).stdout;
  const text = stderr || stdout;
  if (!text) return "";
  return text.toString().trim().split("\n")[0] || "";
}

function hasCommits(cwd: string): boolean {
  try {
    execSync("git rev-parse --verify HEAD", { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getFileHash(filePath: string, root: string): string {
  try {
    return execSync(`git hash-object "${join(root, filePath)}" 2>/dev/null`, {
      encoding: "utf-8",
    }).trim();
  } catch {
    try {
      const content = readFileSync(join(root, filePath));
      return createHash("sha1").update(content).digest("hex");
    } catch {
      return "";
    }
  }
}

function diffHash(raw: string): string {
  return createHash("sha1").update(raw).digest("hex");
}

function getUntrackedFiles(repoDir: string): DiffFile[] {
  try {
    const output = execSync("git ls-files --others --exclude-standard", {
      encoding: "utf-8",
      cwd: repoDir,
    }).trim();
    if (!output) return [];
    const paths = output.split("\n").filter((path) => !path.startsWith(".pi/"));
    // Cap at 100 files — beyond that, reading content is too slow
    const capped = paths.slice(0, 100);
    return capped.map((path) => {
      return {
        path,
        stats: { added: 0, removed: 0 },
        hunks: [],
        reviewed: false,
        stale: false,
        justReviewed: false,
        currentHash: getFileHash(path, repoDir),
        fileType: "untracked" as const,
        isUntracked: true,
      };
    });
  } catch {
    return [];
  }
}

// ─── State Management ────────────────────────────────────

function loadState(slug: string, repoRoot: string): ReviewState {
  const p = statePath(slug, repoRoot);
  if (!existsSync(p)) return { target: "", updatedAt: "", diffHash: "", reviewed: {} };
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return { target: "", updatedAt: "", diffHash: "", reviewed: {} };
  }
}

function saveState(slug: string, repoRoot: string, state: ReviewState): void {
  const dir = dirname(statePath(slug, repoRoot));
  if (!existsSync(dir)) execSync(`mkdir -p "${dir}"`);
  writeFileSync(statePath(slug, repoRoot), JSON.stringify(state, null, 2));
}

// ─── TUI Component ───────────────────────────────────────

class DiffReviewPanel {
  private files: DiffFile[];
  private readonly target: string;
  private readonly repoDir: string;
  private readonly slug: string;
  private readonly theme: Theme;
  private readonly done: (result: ReviewResult | null) => void;
  private diffRaw = "";
  private viewMode: "pending" | "all" = "pending";
  private searchFilter = "";
  private searchMode = false;

  // LSP state
  private lsp?: LspClient;
  private overlay?: DefinitionOverlay;

  // LSP picker state (diff view)
  private pickerMode = false;
  private pickerItems: string[] = [];
  private pickerIndex = 0;

  // Navigation state
  private activeFileIdx = 0;
  private activeHunkIdx = 0;
  private fileScroll = 0;
  private fileLineOffset = 0;

  // Mode state
  private mode: Mode = "review";
  private commentInput = "";
  private activeCompileCommentIdx = 0;
  private loading = false;

  // Render cache
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private tui: { terminal: { rows: number } };

  get termRows(): number {
    return this.tui.terminal.rows;
  }

  constructor(options: {
    files: DiffFile[];
    target: string;
    repoDir: string;
    diffRaw: string;
    slug: string;
    theme: Theme;
    tui: { terminal: { rows: number }; requestRender: () => void };
    done: (result: ReviewResult | null) => void;
    lsp?: LspClient;
  }) {
    const { files, target, repoDir, diffRaw, slug, theme, tui, done, lsp } = options;
    this.files = files;
    this.target = target;
    this.repoDir = repoDir;
    this.diffRaw = diffRaw;
    this.slug = slug;
    this.theme = theme;
    this.tui = tui;
    this.done = done;
    this.lsp = lsp;
    if (lsp) {
      this.overlay = new DefinitionOverlay({ theme, tui, lsp, repoDir });
    }
    // Views are lazy-built when user Tabs to a file
  }

  setLoading(v: boolean): void {
    this.loading = v;
    this.invalidate();
  }

  cancelLoading(): void {
    this.loading = false;
    this.invalidate();
  }

  setFiles(files: DiffFile[], diffRaw: string): void {
    this.files = files;
    this.diffRaw = diffRaw;
    if (files.length > 0) {
      this.buildFileView();
      this.jumpToHunkInView();
    }
    this.invalidate();
  }

  clampAndRefresh(): void {
    if (this.files.length === 0) return;
    this.clampToVisible();
    this.invalidate();
  }

  // ─── Computed ──────────────────────────────────────────

  private reviewedCount(): number {
    return this.files.filter((f) => f.reviewed || f.justReviewed).length;
  }

  private staleCount(): number {
    return this.files.filter((f) => f.stale).length;
  }

  private compileComments(): CompileComment[] {
    const comments: CompileComment[] = [];
    for (const f of this.files) {
      if (f.comment) comments.push({ file: f, kind: "file", text: f.comment });
      if (f.hunkComments) {
        f.hunkComments.forEach((hc, index) => {
          comments.push({
            file: f,
            kind: "hunk",
            index,
            text: hc.text,
            startLine: hc.startLine,
            endLine: hc.endLine,
          });
        });
      }
    }
    return comments;
  }

  private commentedCount(): number {
    return this.compileComments().length;
  }

  private totalFiles(): number {
    return this.files.length;
  }

  private activeFile(): DiffFile {
    return this.files[this.activeFileIdx]!;
  }

  private activeHunk(): DiffHunk | null {
    const f = this.activeFile();
    if (!f || f.hunks.length === 0) return null;
    return f.hunks[this.activeHunkIdx] || null;
  }

  // ─── Actions ───────────────────────────────────────────

  private visibleFiles(): DiffFile[] {
    let list = this.files;
    if (this.viewMode === "pending") {
      // pending = not previously reviewed (reviewed==false).
      // Files reviewed THIS session (justReviewed) stay visible but dimmed.
      list = list.filter((f) => !f.reviewed);
    }
    if (this.searchFilter) {
      const q = this.searchFilter.toLowerCase();
      list = list.filter((f) => f.path.toLowerCase().includes(q));
    }
    return list;
  }

  private clampFileScroll(): void {
    const vis = this.visibleFiles();
    const max = Math.max(0, vis.length - this.visibleFileRows());
    this.fileScroll = Math.max(0, Math.min(this.fileScroll, max));
    // Active file must be in visibleFiles — use vis index, not activeFileIdx
    const active = this.activeFile();
    if (!active) return;
    const visIdx = vis.indexOf(active);
    if (visIdx < 0) return;
    if (visIdx < this.fileScroll) this.fileScroll = visIdx;
    if (visIdx >= this.fileScroll + this.visibleFileRows())
      this.fileScroll = Math.max(0, visIdx - this.visibleFileRows() + 1);
  }

  private clampToVisible(): void {
    const vis = this.visibleFiles();
    if (vis.length === 0) {
      // Nothing visible — stay on current file (will show "nothing pending")
      return;
    }
    const active = this.activeFile();
    if (!active) return;
    if (!vis.includes(active)) {
      const first = vis[0];
      if (!first) return;
      this.activeFileIdx = this.files.indexOf(first);
      this.activeHunkIdx = 0;
      this.fileLineOffset = 0;
      this.buildFileView();
    }
    this.clampFileScroll();
  }

  private visibleFileRows(): number {
    const overhead = 12; // borders, status, separators, help
    const available = this.termRows - overhead;
    if (available < 10) return 5;
    return Math.max(5, Math.floor(available * 0.4));
  }

  private renderedFileRows(): number {
    if (this.files.length === 0) return 0;
    const vis = this.visibleFiles();
    if (vis.length === 0 && this.viewMode === "pending") return 2;
    return Math.min(this.visibleFileRows(), Math.max(0, vis.length - this.fileScroll));
  }

  private currentCommentLineCount(): number {
    const f = this.activeFile();
    if (!f) return 0;
    let count = f.comment && this.mode !== "comment" ? 1 : 0;
    const hunk = this.activeHunk();
    if (hunk && f.hunkComments) {
      count += f.hunkComments.filter((hc) => hc.hunkId === this.activeHunkIdx).length;
    }
    return count;
  }

  private previewContentRows(commentLineCount = this.currentCommentLineCount()): number {
    const targetRows = Math.max(10, this.termRows - 2);
    const rowsBeforePreview = 5 + this.renderedFileRows();
    const footerRows = this.mode === "comment" ? 5 : 3;
    const previewRows = Math.max(1, targetRows - rowsBeforePreview - footerRows - commentLineCount);
    return Math.max(1, previewRows - 2);
  }

  private visibleLineRange(view: DisplayLine[], start: number, end: number): string {
    const visibleLineNumbers = view
      .slice(start, end)
      .map((line) => line.lineNo)
      .filter((lineNo): lineNo is number => lineNo !== undefined);
    if (visibleLineNumbers.length === 0) return "";

    const first = visibleLineNumbers[0];
    const last = visibleLineNumbers[visibleLineNumbers.length - 1];
    return first === last ? `L${first}` : `L${first}-${last}`;
  }

  private navigateFile(delta: number): void {
    const vis = this.visibleFiles();
    if (vis.length === 0) return;
    const curFile = this.activeFile();
    if (!curFile) return;
    const curVisIdx = vis.indexOf(curFile);
    let newVisIdx: number;
    if (curVisIdx < 0) {
      newVisIdx = delta > 0 ? 0 : vis.length - 1;
    } else {
      newVisIdx = (curVisIdx + delta + vis.length) % vis.length;
    }
    const newFile = vis[newVisIdx];
    if (!newFile) return;
    this.activeFileIdx = this.files.indexOf(newFile);
    this.activeHunkIdx = 0;
    this.fileLineOffset = 0;
    this.clampFileScroll();
    this.buildFileView();
    this.jumpToHunkInView();
    this.invalidate();
  }

  private pageSize(): number {
    return Math.max(1, this.previewContentRows() - 1);
  }

  private fileViews = new Map<string, DisplayLine[]>();

  private buildFileView(): void {
    const f = this.activeFile();
    if (!f || f.isBinary || this.fileViews.has(f.path)) return;

    if (f.isUntracked && !f.hunks.length) {
      if (isBinaryFile(f.path, this.repoDir)) {
        f.isBinary = true;
        return;
      }

      const fileLines = readFileLines(f.path, this.repoDir);
      if (!fileLines) return;
      const lines: string[] = [`@@ -0,0 +1,${fileLines.length} @@`];
      for (const l of fileLines) lines.push(`+${l}`);
      f.stats = { added: fileLines.length, removed: 0 };
      f.hunks = [{ id: 0, header: `@@ -0,0 +1,${fileLines.length} @@`, lines, selected: false }];
      this.buildFileViewForHunks();
      return;
    }

    // Not untracked — build from hunks
    this.buildFileViewForHunks();
  }

  private buildFileViewForHunks(): void {
    const f = this.activeFile();
    if (!f || f.isBinary || this.fileViews.has(f.path)) return;

    const fileLines = readFileLines(f.path, this.repoDir);
    const display: DisplayLine[] = [];

    if (!fileLines) return;

    // Build hunk start-line map from hunk headers
    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    // newStart tells us which line in the new file this hunk starts at (1-indexed)
    let lastNewEnd = 1; // 1-indexed

    for (const hunk of f.hunks) {
      const match = hunk.header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) continue;
      const newStart = parseInt(match[3]);
      const newCount = match[4] ? parseInt(match[4]) : 1;

      // Fill gap between last hunk end and this hunk start
      if (newStart > lastNewEnd) {
        for (let i = lastNewEnd - 1; i < newStart - 1 && i < fileLines.length; i++) {
          display.push({ text: fileLines[i] || "", type: "gap", lineNo: i + 1 });
        }
      }

      // Add hunk header
      display.push({ text: hunk.header, type: "hunkHeader", hunkId: hunk.id, lineNo: newStart });

      let oldLine = parseInt(match[1]);
      let newLine = newStart;

      // Add hunk lines
      for (let li = 1; li < hunk.lines.length; li++) {
        const line = hunk.lines[li];
        if (line.startsWith("+") && !line.startsWith("+++")) {
          display.push({ text: line, type: "addition", hunkId: hunk.id, lineNo: newLine });
          newLine++;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          display.push({ text: line, type: "removal", hunkId: hunk.id, lineNo: oldLine });
          oldLine++;
        } else if (line.startsWith("\\") || line === "") {
          display.push({ text: line, type: "context", hunkId: hunk.id });
        } else {
          display.push({ text: line, type: "context", hunkId: hunk.id, lineNo: newLine });
          oldLine++;
          newLine++;
        }
      }

      lastNewEnd = newStart + newCount;
    }

    // Fill gap after last hunk
    if (lastNewEnd <= fileLines.length) {
      for (let i = lastNewEnd - 1; i < fileLines.length; i++) {
        display.push({ text: fileLines[i] || "", type: "gap", lineNo: i + 1 });
      }
    }

    this.fileViews.set(f.path, display);
  }

  private navigateHunk(delta: number): void {
    const f = this.activeFile();
    if (!f) return;
    if (f.hunks.length === 0) {
      this.navigateFile(delta);
      return;
    }

    if (this.activeHunkIdx + delta < 0) {
      // Wrap to previous visible file, last hunk
      this.navigateFile(-1);
      const prev = this.activeFile();
      this.activeHunkIdx = Math.max(0, prev.hunks.length - 1);
      this.jumpToHunkInView();
    } else if (this.activeHunkIdx + delta >= f.hunks.length) {
      // Wrap to next visible file, first hunk
      this.navigateFile(1);
      this.activeHunkIdx = 0;
      this.jumpToHunkInView();
    } else {
      this.activeHunkIdx += delta;
      this.jumpToHunkInView();
    }
    this.invalidate();
  }

  private jumpToHunkInView(): void {
    const f = this.activeFile();
    if (!f) return;
    const view = this.fileViews.get(f.path);
    if (!view) return;
    const targetHunkId = this.activeHunkIdx;
    for (let i = 0; i < view.length; i++) {
      if (view[i].hunkId === targetHunkId && view[i].type === "hunkHeader") {
        this.fileLineOffset = i;
        return;
      }
    }
    this.fileLineOffset = 0;
  }

  private scrollHunk(delta: number): void {
    const f = this.activeFile();
    if (!f) return;
    const view = this.fileViews.get(f.path);
    if (!view || view.length === 0) {
      // No hunks — skip to next file
      if (f.hunks.length === 0) this.navigateHunk(1);
      return;
    }
    const maxScroll = Math.max(0, view.length - 1);
    this.fileLineOffset = Math.max(0, Math.min(maxScroll, this.fileLineOffset + delta));

    // Update activeHunkIdx based on scroll position — find which hunk we're in
    for (let i = this.fileLineOffset; i >= 0; i--) {
      if (view[i].type === "hunkHeader" && view[i].hunkId !== undefined) {
        this.activeHunkIdx = view[i].hunkId!;
        break;
      }
    }
    this.invalidate();
  }

  private toggleReviewed(): void {
    const f = this.activeFile();
    if (!f) return;
    if (f.reviewed) {
      // Previously reviewed file — Space unmarks it (overrides state)
      f.reviewed = false;
      f.justReviewed = false;
      f.stale = false;
    } else if (f.justReviewed) {
      // Just reviewed this session — Space undoes it
      f.justReviewed = false;
      f.stale = false;
    } else {
      // Unreviewed — mark as reviewed this session
      f.justReviewed = true;
      f.stale = false;
    }
    this.persistState();
    this.invalidate();
  }

  private resetAll(): void {
    for (const f of this.files) {
      f.reviewed = false;
      f.stale = false;
      f.justReviewed = false;
      f.comment = undefined;
    }
    this.invalidate();
  }

  private goToStart(): void {
    const vis = this.visibleFiles();
    if (vis.length === 0) return;
    this.activeFileIdx = this.files.indexOf(vis[0]);
    this.activeHunkIdx = 0;
    this.fileLineOffset = 0;
    this.fileScroll = 0;
    this.jumpToHunkInView();
    this.invalidate();
  }

  private goToEnd(): void {
    const vis = this.visibleFiles();
    if (vis.length === 0) return;
    const last = vis[vis.length - 1];
    this.activeFileIdx = this.files.indexOf(last);
    this.activeHunkIdx = Math.max(0, last.hunks.length - 1);
    this.fileLineOffset = 0;
    this.clampFileScroll();
    this.jumpToHunkInView();
    this.invalidate();
  }

  private definitionTarget(): string {
    const f = this.activeFile();
    if (!f || f.isBinary || !this.lsp) return "";
    const view = this.fileViews.get(f.path);
    if (!view) return "";
    const dl = view[this.fileLineOffset];
    if (!dl || !dl.lineNo) return "";
    const fileLines = readFileLines(f.path, this.repoDir);
    if (!fileLines) return "";
    const actualLine = fileLines[dl.lineNo - 1];
    if (!actualLine) return "";
    const m = actualLine.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/);
    return m ? m[0] : "";
  }

  private enterPickerMode(): void {
    const f = this.activeFile();
    if (!f || f.isBinary || !this.lsp) return;

    const view = this.fileViews.get(f.path);
    if (!view) return;

    const dl = view[this.fileLineOffset];
    if (!dl || !dl.lineNo) return;

    const fileLines = readFileLines(f.path, this.repoDir);
    if (!fileLines) return;

    const actualLine = fileLines[dl.lineNo - 1];
    if (!actualLine) return;

    const items = [...actualLine.matchAll(/[a-zA-Z_$][a-zA-Z0-9_$]*/g)].map((m) => m[0]);
    if (items.length === 0) return;

    if (items.length === 1) {
      this.jumpToDefinition(items[0]);
      return;
    }

    this.pickerMode = true;
    this.pickerItems = items;
    this.pickerIndex = 0;
    this.invalidate();
  }

  private jumpToDefinition(symbol: string): void {
    const f = this.activeFile();
    if (!f || f.isBinary || !this.overlay || !this.lsp) return;

    const view = this.fileViews.get(f.path);
    if (!view) return;

    const dl = view[this.fileLineOffset];
    if (!dl || !dl.lineNo) return;

    const fileLines = readFileLines(f.path, this.repoDir);
    if (!fileLines) return;

    const actualLine = fileLines[dl.lineNo - 1];
    if (!actualLine) return;

    const idx = actualLine.indexOf(symbol);
    if (idx === -1) return;

    const uri = `file://${join(this.repoDir, f.path)}`;
    this.lsp.openDocument(uri, fileLines.join("\n"));
    this.overlay.push(uri, dl.lineNo - 1, idx);
  }

  private enterCommentMode(): void {
    this.commentInput = "";
    this.mode = "comment";
    this.invalidate();
  }

  private submitComment(): void {
    const f = this.activeFile();
    const trimmed = this.commentInput.trim();
    if (!trimmed) return;

    const hunk = this.activeHunk();
    const view = this.fileViews.get(f.path);

    // Calculate visible line range for the current hunk
    let startLine = 0;
    let endLine = 0;
    if (hunk && view) {
      const match = hunk.header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        startLine = parseInt(match[3]);
        endLine = startLine + (match[4] ? parseInt(match[4]) : 1) - 1;
      }
    }

    if (!f.hunkComments) f.hunkComments = [];
    f.hunkComments.push({
      hunkId: this.activeHunkIdx,
      text: trimmed,
      startLine,
      endLine,
    });

    f.justReviewed = true;
    f.stale = false;
    this.commentInput = "";
    this.mode = "review";
    this.invalidate();
  }

  private cancelComment(): void {
    this.commentInput = "";
    this.mode = "review";
    this.invalidate();
  }

  private enterCompileView(): void {
    if (this.commentedCount() === 0) return;
    this.mode = "compile";
    this.activeCompileCommentIdx = Math.min(
      this.activeCompileCommentIdx,
      Math.max(0, this.commentedCount() - 1),
    );
    this.invalidate();
  }

  private exitCompileView(): void {
    this.mode = "review";
    this.invalidate();
  }

  private injectComments(): void {
    const msg = formatCommentsMessage(this.target, this.files);
    if (!msg) return;
    this.done({
      hunks: [],
      files: [],
      question: msg,
      target: this.target,
    });
  }

  private navigateCompileComment(delta: number): void {
    const count = this.commentedCount();
    if (count === 0) return;
    this.activeCompileCommentIdx = (this.activeCompileCommentIdx + delta + count) % count;
    this.invalidate();
  }

  private deleteActiveCompileComment(): void {
    const comments = this.compileComments();
    const current = comments[this.activeCompileCommentIdx];
    if (!current) return;

    if (current.kind === "file") {
      current.file.comment = undefined;
    } else {
      current.file.hunkComments?.splice(current.index, 1);
      if (current.file.hunkComments?.length === 0) current.file.hunkComments = undefined;
    }

    const count = this.commentedCount();
    if (count === 0) {
      this.activeCompileCommentIdx = 0;
      this.mode = "review";
    } else {
      this.activeCompileCommentIdx = Math.min(this.activeCompileCommentIdx, count - 1);
    }
    this.persistState();
    this.invalidate();
  }

  persistState(): void {
    const p = statePath(this.slug, this.repoDir);
    const dir = dirname(p);
    // if (!existsSync(dir)) {
    //   execSync(`mkdir -p "${dir}"`);
    // }
    // using node fs directly
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        console.error("Error creating directory for state:", err);
        return;
      }
    }

    // Load existing state to merge with current session marks
    const existing = loadState(this.slug, this.repoDir).reviewed || {};
    const root = gitRoot(this.repoDir) || this.repoDir;

    const reviewed: Record<string, ReviewedEntry> = {};
    for (const f of this.files) {
      // Merge: keep existing entries for files still in diff, add newly reviewed
      if (existing[f.path]) {
        reviewed[f.path] = existing[f.path] as ReviewedEntry;
      }
      // Override/add for files checked this session OR previously reviewed
      if (f.justReviewed || f.reviewed) {
        if (!f.currentHash) {
          f.currentHash = getFileHash(f.path, root);
        }
        reviewed[f.path] = {
          hash: f.currentHash,
          reviewedAt: new Date().toISOString(),
        };
        if (f.comment) reviewed[f.path].comment = f.comment;
        if (f.hunkComments && f.hunkComments.length > 0) {
          reviewed[f.path].comments = f.hunkComments.map((hc) => ({
            hunkStart: hc.startLine,
            hunkEnd: hc.endLine,
            text: hc.text,
          }));
        }
      }
      // Remove from state if unchecked
      if (!f.reviewed && !f.justReviewed) {
        delete reviewed[f.path];
      }
    }
    saveState(this.slug, this.repoDir, {
      target: this.target,
      updatedAt: new Date().toISOString(),
      diffHash: diffHash(this.diffRaw),
      reviewed,
    });
  }

  // ─── Render ────────────────────────────────────────────

  private finishRender(width: number, lines: string[], footerLines = 3): string[] {
    const targetRows = Math.max(lines.length, this.termRows - 2);
    while (lines.length < targetRows) {
      lines.splice(Math.max(0, lines.length - footerLines), 0, "");
    }
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  render(width: number): string[] {
    if (this.overlay?.active) {
      return this.overlay.render(width);
    }
    if (this.cachedLines.length > 0 && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const lines: string[] = [];
    const add = (s: string) => lines.push(s);

    // ── Loading state ────────────────────────────────────
    if (this.loading) {
      add(th.fg("accent", "─".repeat(width)));
      add(" " + th.fg("toolTitle", th.bold("Diff Review")));
      add(" " + th.fg("text", th.bold(`Target: ${this.target}`)));
      add("");
      if (this.files.length === 0) {
        add(" " + th.fg("muted", "⏳ Running git diff..."));
      } else {
        add(
          " " + th.fg("muted", `⏳ Computing review state... (${this.files.length} files loaded)`),
        );
      }
      add("");
      add(th.fg("accent", "─".repeat(width)));
      return this.finishRender(width, lines, 1);
    }

    // ── Top border + status bar ──────────────────────────
    const reviewed = this.reviewedCount();
    const total = this.totalFiles();
    const stale = this.staleCount();
    const commented = this.commentedCount();
    let statusText = `Diff Review — ${reviewed}/${total} reviewed`;
    if (stale > 0) statusText += `, ${stale} stale`;
    if (commented > 0) statusText += `, ${commented} commented`;
    statusText += ` — ${this.target}`;

    const borderChar = "─";
    const topBorder = borderChar.repeat(width);
    add(th.fg("border", topBorder));
    add(" " + th.fg("toolTitle", th.bold(statusText)));
    add("");

    // ── File list ────────────────────────────────────────
    const vis = this.visibleFiles();
    const fileRows = this.visibleFileRows();
    const fileEnd = Math.min(this.fileScroll + fileRows, vis.length);

    // Search / view mode line
    let modeLine = `[${this.viewMode === "pending" ? "pending" : "all"}]`;
    if (this.searchMode) {
      modeLine = `🔍 ${this.searchFilter}█`;
    } else if (this.searchFilter) {
      modeLine += ` 🔍 "${this.searchFilter}"`;
    } else if (vis.length < this.files.length) {
      modeLine += ` (${vis.length}/${this.files.length})`;
    }
    add(" " + th.fg(this.searchMode ? "accent" : "dim", modeLine));

    if (this.files.length === 0) {
      // No file-list rows; give the space to the preview/empty-state area instead.
    } else if (vis.length === 0 && this.viewMode === "pending") {
      add(" " + th.fg("success", "✔ All files reviewed!"));
      add(" " + th.fg("dim", "  Press [v] to view all files, or press [r] to reset"));
    } else {
      for (let i = this.fileScroll; i < fileEnd; i++) {
        const f = vis[i];
        if (!f) continue;
        const isActive = f === this.activeFile();

        // Checkmark
        let check: string;
        if (f.reviewed && f.stale) {
          check = th.fg("warning", "⚠");
        } else if (f.reviewed || f.justReviewed) {
          check = th.fg("muted", "✓");
        } else {
          check = th.fg("text", " ");
        }

        // File type
        const typeMap: Record<string, string> = {
          added: "A",
          deleted: "D",
          modified: "M",
          untracked: "U",
        };
        const typeColor =
          f.fileType === "added" || f.fileType === "untracked"
            ? "success"
            : f.fileType === "deleted"
              ? "error"
              : "dim";
        const typeTag = th.fg(typeColor, `[${typeMap[f.fileType]}]`);

        // Comment indicator
        const totalComments = (f.comment ? 1 : 0) + (f.hunkComments ? f.hunkComments.length : 0);
        const bubble =
          totalComments > 0 ? ` 💬${totalComments > 1 ? `×${totalComments}` : ""}` : "";

        // Arrow for active file
        const arrow = isActive ? th.fg("accent", "►") : " ";

        // File path — dim if previously reviewed OR just reviewed
        const pathStr =
          f.reviewed || f.justReviewed ? th.fg("muted", f.path) : th.fg("text", f.path);

        // Stats
        const stats = th.fg("dim", `+${f.stats.added} -${f.stats.removed}`);

        if (f.isBinary) {
          const line = `${arrow} [${check}] ${typeTag} ${f.path}  (binary)`;
          add(truncateToWidth(line, width));
        } else if (f.stats.added === 0 && f.stats.removed === 0 && f.hunks.length === 0) {
          add(
            truncateToWidth(
              `${arrow} [${check}]${bubble} ${typeTag} ${pathStr}  (mode/permissions)`,
              width,
            ),
          );
        } else {
          add(
            truncateToWidth(`${arrow} [${check}]${bubble} ${typeTag} ${pathStr}  ${stats}`, width),
          );
        }
      }
    } // end vis.length > 0 else block

    // ── Separator ────────────────────────────────────────
    add(th.fg("border", borderChar.repeat(width)));

    // ── Compile view ─────────────────────────────────────
    if (this.mode === "compile") {
      add(" " + th.fg("accent", th.bold("Review Comments")));
      add("");
      const comments = this.compileComments();
      for (let i = 0; i < comments.length; i++) {
        const comment = comments[i];
        const arrow = i === this.activeCompileCommentIdx ? th.fg("accent", "►") : " ";
        const lineInfo =
          comment.kind === "hunk" && comment.startLine > 0
            ? ` (L${comment.startLine}-${comment.endLine})`
            : "";
        add(`${arrow} ${th.fg("text", `${comment.file.path}${lineInfo}`)}`);
        add("  " + th.fg("muted", `> ${comment.text}`));
        add("");
      }
      add(th.fg("border", borderChar.repeat(width)));
      add(" " + th.fg("dim", "[↑↓/j/k] move  [d/Del] delete  [c/Esc] back  [C] inject comments"));
      add(th.fg("border", borderChar.repeat(width)));

      return this.finishRender(width, lines, 2);
    }

    if (this.files.length === 0) {
      add(" " + th.fg("success", "✔ No changes found"));
      add(" " + th.fg("dim", `  git diff ${this.target} returned no files`));
      add("");
      add(th.fg("border", borderChar.repeat(width)));
      add("");
      add(" " + th.fg("dim", "[Esc] close"));
      add(th.fg("border", borderChar.repeat(width)));

      return this.finishRender(width, lines);
    }

    // ── File view ────────────────────────────────────────
    const f = this.activeFile();
    const view = this.fileViews.get(f.path);
    const hunk = this.activeHunk();
    const commentLines: string[] = [];
    if (f.comment && this.mode !== "comment") {
      commentLines.push(" " + th.fg("muted", `NOTE: ${f.comment}`));
    }
    if (hunk && f.hunkComments) {
      const hunkComms = f.hunkComments.filter((hc) => hc.hunkId === this.activeHunkIdx);
      for (const hc of hunkComms) {
        const lineInfo = hc.startLine > 0 ? ` (L${hc.startLine}-${hc.endLine})` : "";
        commentLines.push(" " + th.fg("muted", `💬${lineInfo}: ${hc.text}`));
      }
    }

    const targetRows = Math.max(lines.length, this.termRows - 2);
    const footerRows = this.mode === "comment" ? 5 : 3;
    const previewRows = Math.max(1, targetRows - lines.length - footerRows - commentLines.length);
    const previewStart = lines.length;
    const padPreview = () => {
      while (lines.length - previewStart < previewRows) add(" " + th.fg("dim", "~"));
    };

    if (this.pickerMode) {
      add(" " + th.fg("accent", "Select symbol to jump to definition:"));
      for (let i = 0; i < this.pickerItems.length; i++) {
        const arrow = i === this.pickerIndex ? th.fg("accent", "►") : " ";
        const item = this.pickerItems[i]!;
        const styled = i === this.pickerIndex ? th.bold(th.fg("text", item)) : th.fg("text", item);
        add(`  ${arrow} ${styled}`);
      }
      padPreview();
    } else if (f.isBinary) {
      add(" " + th.fg("muted", "Binary file — cannot display diff"));
      padPreview();
    } else if (view && view.length > 0) {
      let remaining = previewRows;
      if (hunk && remaining > 0) {
        const hunkHeader = `Hunk ${this.activeHunkIdx + 1}/${f.hunks.length} — ${hunk.header} ${f.path}`;
        add(" " + th.fg("accent", truncateToWidth(hunkHeader, width - 1)));
        remaining--;
      }

      const indicatorRows = remaining > 1 ? 1 : 0;
      const contentRows = Math.max(0, remaining - indicatorRows);
      const start = this.fileLineOffset;
      const end = Math.min(start + contentRows, view.length);

      for (let i = start; i < end; i++) {
        const dl = view[i];
        let styled: string;
        if (dl.type === "addition") {
          styled = th.fg("toolDiffAdded", dl.text);
        } else if (dl.type === "removal") {
          styled = th.fg("toolDiffRemoved", dl.text);
        } else if (dl.type === "hunkHeader") {
          styled = th.fg("accent", dl.text);
        } else if (dl.type === "gap") {
          styled = th.fg("toolDiffContext", dl.text);
        } else {
          styled = th.fg("toolDiffContext", dl.text);
        }

        add(" " + truncateToWidth(styled, width - 1));
      }

      while (lines.length - previewStart < previewRows - indicatorRows) {
        add(" " + th.fg("dim", "~"));
      }

      if (indicatorRows > 0) {
        const lineRange = this.visibleLineRange(view, start, end);
        const scrollPct =
          view.length > contentRows
            ? (() => {
                const maxOffset = Math.max(1, view.length - contentRows);
                const pct =
                  this.fileLineOffset > 0 ? Math.round((this.fileLineOffset / maxOffset) * 100) : 0;
                return `${pct}%`;
              })()
            : "";
        add(" " + th.fg("dim", [lineRange, scrollPct].filter(Boolean).join(" · ")));
      }
    } else if (f.hunks.length === 0 && (!view || view.length === 0)) {
      add(" " + th.fg("muted", "No content changes (mode/permissions only)"));
      padPreview();
    } else if (view && view.length === 0) {
      add(" " + th.fg("muted", "No content changes (mode/permissions only)"));
      padPreview();
    } else {
      add(" " + th.fg("muted", "Loading file..."));
      padPreview();
    }

    for (const line of commentLines) add(line);

    // ── Separator ────────────────────────────────────────
    add(th.fg("border", borderChar.repeat(width)));

    // ── Input bar ────────────────────────────────────────
    if (this.mode === "comment") {
      add(" " + th.fg("accent", `Comment: ${f.path}`));
      const cursor = "█";
      add(" " + th.fg("text", `> ${this.commentInput}${cursor}`));
    }

    // ── Help bar ─────────────────────────────────────────
    if (this.mode === "comment") {
      add(" " + th.fg("dim", "[Enter] save  [Esc] cancel"));
    } else if (this.pickerMode) {
      add(" " + th.fg("dim", "[↑↓/j/k] navigate  [Enter] jump  [Esc] cancel"));
    } else {
      const lspHint = this.lsp ? `  [→] goto ${this.definitionTarget()}` : "";
      add(
        " " +
          th.fg(
            "dim",
            "[Tab] file  [j/k] hunk  [↑↓/PgUp/PgDn] scroll  [Space] ✓  [c] comment  [C] compile  [v] mode  [/] search  [r] reset  [Esc] close" +
              lspHint,
          ),
      );
    }

    // ── Bottom border ────────────────────────────────────
    add(th.fg("border", borderChar.repeat(width)));

    return this.finishRender(width, lines, this.mode === "comment" ? 5 : 3);
  }

  // ─── Input Handling ────────────────────────────────────

  handleInput(data: string): void {
    // Loading state — only Esc works to cancel
    if (this.loading) {
      if (matchesKey(data, Key.escape)) {
        // Set flag so doLoad exits early
        this.loading = false;
        this.done(null);
      }
      return;
    }

    // Picker mode — inline symbol selection for go-to-definition
    if (this.pickerMode) {
      if (matchesKey(data, Key.escape)) {
        this.pickerMode = false;
        this.pickerItems = [];
        this.invalidate();
        return;
      }
      if (data === "j" || matchesKey(data, Key.down)) {
        this.pickerIndex = (this.pickerIndex + 1) % this.pickerItems.length;
        this.invalidate();
        return;
      }
      if (data === "k" || matchesKey(data, Key.up)) {
        this.pickerIndex = (this.pickerIndex - 1 + this.pickerItems.length) % this.pickerItems.length;
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const symbol = this.pickerItems[this.pickerIndex];
        if (symbol) {
          this.pickerMode = false;
          this.pickerItems = [];
          this.jumpToDefinition(symbol);
        }
        return;
      }
      return;
    }

    if (this.mode === "compile") {
      if (data === "c" || matchesKey(data, Key.escape)) {
        this.exitCompileView();
      } else if (data === "C" || matchesKey(data, Key.shift("c"))) {
        this.injectComments();
      } else if (data === "j" || matchesKey(data, Key.down)) {
        this.navigateCompileComment(1);
      } else if (data === "k" || matchesKey(data, Key.up)) {
        this.navigateCompileComment(-1);
      } else if (data === "d" || matchesKey(data, Key.delete) || matchesKey(data, Key.backspace)) {
        this.deleteActiveCompileComment();
      }
      return;
    }

    // LSP definition overlay navigation
    if (this.overlay?.active) {
      if (this.overlay.pickerMode) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
          this.overlay.cancelPicker();
          return;
        }
        if (data === "j" || matchesKey(data, Key.down)) {
          this.overlay.navigatePicker(1);
          return;
        }
        if (data === "k" || matchesKey(data, Key.up)) {
          this.overlay.navigatePicker(-1);
          return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
          this.overlay.selectPicker();
          return;
        }
        return;
      }
      if (matchesKey(data, Key.left)) {
        if (!this.overlay.pop()) this.invalidate();
        return;
      }
      if (matchesKey(data, Key.right)) {
        this.overlay.diveDeeper();
        return;
      }
      if (matchesKey(data, Key.up)) {
        this.overlay.scroll(-1);
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.overlay.scroll(1);
        return;
      }
      if (matchesKey(data, Key.pageUp)) {
        this.overlay.scroll(-10);
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        this.overlay.scroll(10);
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.overlay.clear();
        return;
      }
    }

    if (this.mode === "comment") {
      if (matchesKey(data, Key.enter)) {
        this.submitComment();
      } else if (matchesKey(data, Key.escape)) {
        this.cancelComment();
      } else if (matchesKey(data, Key.backspace)) {
        this.commentInput = this.commentInput.slice(0, -1);
        this.invalidate();
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.commentInput += data;
        this.invalidate();
      } else {
        // Pass to normal navigation handler
        this.handleReviewInput(data);
      }
      return;
    }

    this.handleReviewInput(data);
  }

  private handleReviewInput(data: string): void {
    // Search mode — typing filters files
    if (this.searchMode) {
      if (matchesKey(data, Key.escape)) {
        this.searchMode = false;
        this.searchFilter = "";
        this.fileScroll = 0;
        this.clampToVisible();
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.searchFilter = this.searchFilter.slice(0, -1);
        this.fileScroll = 0;
        this.clampToVisible();
        this.invalidate();
        return;
      }
      if (data === "/") {
        this.searchMode = false;
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        // Commit search, exit mode
        this.searchMode = false;
        this.fileScroll = 0;
        this.clampToVisible();
        this.invalidate();
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.searchFilter += data;
        this.fileScroll = 0;
        this.clampToVisible();
        this.invalidate();
        return;
      }
      // Any other key exits search mode
      this.searchMode = false;
      this.invalidate();
      // Fall through to normal handling
    }

    // Navigation
    if (data === "j") {
      this.navigateHunk(1);
      return;
    }
    if (data === "k") {
      this.navigateHunk(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollHunk(1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollHunk(-1);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollHunk(this.pageSize());
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollHunk(-this.pageSize());
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.navigateFile(1);
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.navigateFile(-1);
      return;
    }

    // LSP go-to-definition (diff view only)
    if (this.lsp && matchesKey(data, Key.right)) {
      this.enterPickerMode();
      return;
    }

    // Actions
    if (data === " " || matchesKey(data, Key.space)) {
      this.toggleReviewed();
      return;
    }
    if (data === "c" && this.mode === "review") {
      this.enterCommentMode();
      return;
    }
    if (data === "C" || matchesKey(data, Key.shift("c"))) {
      this.enterCompileView();
      return;
    }
    if (data === "g") {
      this.goToStart();
      return;
    }
    if (data === "G") {
      this.goToEnd();
      return;
    }
    if (data === "r") {
      this.resetAll();
      return;
    }
    if (data === "v") {
      this.viewMode = this.viewMode === "pending" ? "all" : "pending";
      this.fileScroll = 0;
      this.clampToVisible();
      this.invalidate();
      return;
    }
    if (data === "/") {
      this.searchMode = !this.searchMode;
      if (!this.searchMode) this.searchFilter = "";
      this.fileScroll = 0;
      this.clampFileScroll();
      this.invalidate();
      return;
    }

    // Input editing
    if (matchesKey(data, Key.enter)) {
      // Enter = compile comments and close
      const msg = formatCommentsMessage(this.target, this.files);
      this.done({
        hunks: [],
        files: [],
        question: msg || "",
        target: this.target,
      });
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.commentInput = this.commentInput.slice(0, -1);
      this.invalidate();
      return;
    }

    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.commentInput += data;
      this.invalidate();
    }
  }

  // ─── Invalidation ──────────────────────────────────────

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = [];
  }
}

// ─── Extension Entry Point ───────────────────────────────

export default function diffReviewExtension(pi: ExtensionAPI) {
  pi.registerCommand("diff-review", {
    description: "Review git diff interactively — check files, comment on hunks, compile notes",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("diff-review requires interactive mode", "error");
        return;
      }

      // Check for --lsp flag
      const rawArgs = (args || "").trim();
      const useLsp = rawArgs.includes("--lsp");
      const cleanArgs = rawArgs.replace(/--lsp/g, "").trim();

      // Preferred syntax: "<repo-path> <diff-target>".
      // Legacy "<diff-target> @<repo-path>" is still accepted.
      const { target, repoPath } = parseCommandArgs(cleanArgs, ctx.cwd);

      // Validate git repo and normalize to the reviewed repo root.
      const requestedRepoDir = repoPath || ctx.cwd;
      const root = gitRoot(requestedRepoDir);
      if (!root) {
        ctx.ui.notify(
          repoPath ? `Not a git repository: ${repoPath}` : "Not in a git repository",
          "error",
        );
        return;
      }
      const repoDir = root;

      const diffTarget = target;
      const slug = slugify(diffTarget);
      const state = loadState(slug, repoDir);

      // Start LSP client if requested
      let lsp: LspClient | undefined;
      if (useLsp) {
        lsp = new LspClient();
        try {
          await lsp.start(repoDir);
        } catch (e) {
          ctx.ui.notify(`LSP failed to start: ${(e as Error).message}`, "error");
          lsp = undefined;
        }
      }

      // Open overlay IMMEDIATELY with loading state, then stream results in
      const result = await ctx.ui.custom<ReviewResult | null>(
        (tui, theme, _kb, done) => {
          // Pass empty files initially — loading state. Files stream in via setFiles().
          // diffRaw starts empty but gets populated when setFiles() is called with actual diff.
          const panel = new DiffReviewPanel({
            files: [],
            target: diffTarget,
            repoDir,
            diffRaw: "",
            slug: slugify(diffTarget),
            theme,
            tui,
            done,
            lsp,
          });
          panel.setLoading(true);

          let cancelled = false;

          // Async: run git operations in chunks, yielding to UI each time
          const doLoad = async () => {
            // Step 1: git diff
            let raw: string;
            try {
              raw = hasCommits(repoDir) ? gitDiff(diffTarget, repoDir) : "";
            } catch (error) {
              const detail = gitErrorMessage(error);
              const message = detail
                ? `git diff failed for target: ${diffTarget} — ${detail}`
                : `git diff failed for target: ${diffTarget}`;
              ctx.ui.notify(message, "error");
              done(null);
              return;
            }
            if (cancelled) return;

            // Step 2: parse diff
            const diffFiles = raw.trim() ? parseDiff(raw) : [];

            // Yield to UI
            await new Promise((r) => setTimeout(r, 0));
            if (cancelled) return;

            // Step 3: get untracked files
            const untracked = diffTarget === "--cached" ? [] : getUntrackedFiles(repoDir);
            const files = diffFiles.concat(untracked);

            if (cancelled) return;

            // Step 4: load review state + compute hashes (batched)
            const stored = state.reviewed || {};
            const currentHash = diffHash(raw);
            const diffChanged = state.diffHash && state.diffHash !== currentHash;

            let batchCount = 0;
            for (const f of files) {
              if (cancelled) return;
              if (f.isUntracked) {
                const entry = stored[f.path];
                if (entry && entry.hash === f.currentHash) {
                  f.reviewed = true;
                  f.stale = false;
                  if (entry.comment) f.comment = entry.comment;
                } else if (entry) {
                  f.reviewed = false;
                  f.stale = true;
                  if (entry.comment) f.comment = entry.comment;
                }
                continue;
              }
              const entry = stored[f.path];
              if (!entry && !diffChanged) {
                f.currentHash = "";
                continue;
              }
              f.currentHash = getFileHash(f.path, root);
              if (entry && entry.hash === f.currentHash && !diffChanged) {
                f.reviewed = true;
                f.stale = false;
                if (entry.comment) f.comment = entry.comment;
                if (entry.comments) {
                  f.hunkComments = entry.comments.map((c) => ({
                    hunkId: -1,
                    text: c.text,
                    startLine: c.hunkStart,
                    endLine: c.hunkEnd,
                  }));
                }
              } else if (entry && entry.hash !== f.currentHash) {
                f.reviewed = false;
                f.stale = true;
                if (entry.comment) f.comment = entry.comment;
              } else if (entry) {
                f.reviewed = true;
                f.stale = false;
                if (entry.comment) f.comment = entry.comment;
              }

              // Yield to UI every 10 files
              batchCount++;
              if (batchCount % 10 === 0) {
                await new Promise((r) => setTimeout(r, 0));
              }
            }
            if (cancelled) return;

            // Clean up state file
            const currentPaths = new Set(files.map((f) => f.path));

            // Clean removed files from the in-memory stored (no disk write here —
            // persistState on Space will merge with existing state naturally)
            for (const p of Object.keys(stored)) {
              if (!currentPaths.has(p)) {
                delete stored[p];
              }
            }

            // Push files to panel and finalize
            panel.setFiles(files, raw);
            panel.setLoading(false);
            panel.clampAndRefresh();
            tui.requestRender();
          };

          doLoad();

          return {
            render: (w) => panel.render(w),
            handleInput: (data) => {
              panel.handleInput(data);
              tui.requestRender();
            },
            invalidate: () => panel.invalidate(),
          };
        },
        {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "95%",
            anchor: "top-center",
            margin: 1,
            visible: (w: number) => w >= 60,
          },
        },
      );

      // Shutdown LSP client after overlay closes
      if (lsp) {
        await lsp.shutdown();
      }

      if (!result) {
        // User closed with Esc — state was already saved (Escape handler calls persistState)
        // But if Escape was captured by overlay before our handler, persist now:
        return;
      }

      // Check if this is a compiled-comments injection
      if (result.question.startsWith("[Diff Review — Compiled Comments")) {
        pi.sendUserMessage(result.question);
        ctx.ui.notify("Comments injected into chat", "info");
        return;
      }

      pi.sendUserMessage(result.question);
      ctx.ui.notify("Comments injected into chat", "info");
    },
  });
}
