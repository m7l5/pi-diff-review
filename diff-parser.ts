/**
 * Diff parser — parses unified diff output into structured DiffFile[].
 * Pure function, no side effects, fully testable.
 */

export type DiffHunk = {
  id: number;
  header: string;
  lines: string[];
  selected: boolean;
};

export type DiffFile = {
  path: string;
  stats: { added: number; removed: number };
  hunks: DiffHunk[];
  reviewed: boolean;
  stale: boolean;
  justReviewed: boolean;
  currentHash: string;
  comment?: string;
  hunkComments?: { hunkId: number; text: string; startLine: number; endLine: number }[];
  isBinary?: boolean;
  fileType: "added" | "deleted" | "modified" | "untracked";
  isUntracked?: boolean;
};

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split("\n");
  let current: DiffFile | null = null;
  let hunkLines: string[] = [];

  function pushHunk() {
    if (!current || hunkLines.length === 0) return;
    const header = hunkLines[0];
    if (typeof header !== "string") return;
    current.hunks.push({
      id: current.hunks.length,
      header,
      lines: hunkLines,
      selected: false,
    });
    hunkLines = [];
  }

  function finishFile() {
    if (!current) return;
    pushHunk();
    let added = 0;
    let removed = 0;
    for (const h of current.hunks) {
      for (const l of h.lines) {
        if (l.startsWith("+") && !l.startsWith("+++")) added++;
        if (l.startsWith("-") && !l.startsWith("---")) removed++;
      }
    }
    current.stats = { added, removed };
    files.push(current);
    current = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      finishFile();
      const path = line.split(" b/")[1];
      if (path) {
        current = {
          path,
          stats: { added: 0, removed: 0 },
          hunks: [],
          reviewed: false,
          stale: false,
          justReviewed: false,
          currentHash: "",
          isBinary: false,
          fileType: "modified",
          isUntracked: false,
        };
      }
      continue;
    }

    if (!current) continue;

    // Detect file type from diff header
    if (line.startsWith("--- /dev/null")) current.fileType = "added";
    if (line.startsWith("+++ /dev/null")) current.fileType = "deleted";

    if (line.startsWith("Binary files ")) {
      current.isBinary = true;
      continue;
    }

    if (line.startsWith("@@")) {
      pushHunk();
      hunkLines = [line];
      continue;
    }

    if (hunkLines.length > 0) {
      if (
        line.startsWith(" ") ||
        line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith("\\") ||
        line === ""
      ) {
        hunkLines.push(line);
      }
    }
  }

  finishFile();
  return files;
}
