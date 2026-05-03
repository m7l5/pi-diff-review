import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import diffReviewExtension from "../index.js";
import { slugify, statePath } from "../state.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

async function runDiffReview(repoDir: string, inputs: string[], cwd = repoDir): Promise<string> {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  let loadedOutput = "";

  diffReviewExtension({
    registerCommand: (_name: string, command: { handler: typeof handler }) => {
      handler = command.handler;
    },
    sendUserMessage: () => {},
  } as any);

  assert.ok(handler, "diff-review command should register a handler");

  await handler(`HEAD @${repoDir}`, {
    hasUI: true,
    cwd,
    ui: {
      notify: () => {},
      custom: async (factory: any) => {
        return await new Promise((resolve, reject) => {
          const tui = {
            terminal: { rows: 40 },
            requestRender: () => {},
          };
          const widget = factory(tui, theme, {}, resolve);

          const waitForLoaded = async () => {
            for (let attempt = 0; attempt < 100; attempt++) {
              const output = widget.render(100).join("\n");
              const loading =
                output.includes("Running git diff") || output.includes("Computing review state");
              if (!loading) {
                loadedOutput = output;
                for (const input of inputs) {
                  widget.handleInput(input);
                }
                return;
              }
              await new Promise((r) => setTimeout(r, 5));
            }
            reject(new Error("diff-review did not finish loading"));
          };

          waitForLoaded().catch(reject);
        });
      },
    },
  });

  return loadedOutput;
}

function git(repoDir: string, command: string): string {
  return execSync(command, { cwd: repoDir, encoding: "utf-8" }).trim();
}

describe("diff-review persistence", () => {
  it("starts in a repo with no commits and shows untracked files", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "diff-review-unborn-"));
    try {
      git(repoDir, "git init -q");
      writeFileSync(join(repoDir, "a.txt"), "untracked\n");

      const output = await runDiffReview(repoDir, ["\x1b"]);

      assert.match(output, /a\.txt/);
      assert.match(output, /\[U\]/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("stores state in the reviewed repo root, not the launch cwd", async () => {
    const cwdRepo = mkdtempSync(join(tmpdir(), "diff-review-cwd-"));
    const reviewedRoot = mkdtempSync(join(tmpdir(), "diff-review-reviewed-"));
    try {
      git(cwdRepo, "git init -q");
      git(reviewedRoot, "git init -q");
      git(reviewedRoot, "git config user.email test@example.com");
      git(reviewedRoot, "git config user.name Test");
      mkdirSync(join(reviewedRoot, "sub"));
      writeFileSync(join(reviewedRoot, "sub", "a.txt"), "one\n");
      git(reviewedRoot, "git add sub/a.txt");
      git(reviewedRoot, "git commit -q -m init");
      writeFileSync(join(reviewedRoot, "sub", "a.txt"), "one\ntwo\n");

      await runDiffReview(join(reviewedRoot, "sub"), [" ", "\x1b"], cwdRepo);

      const expectedState = statePath(slugify("HEAD"), reviewedRoot);
      assert.equal(existsSync(expectedState), true);
      assert.equal(existsSync(statePath(slugify("HEAD"), cwdRepo)), false);
      assert.equal(existsSync(statePath(slugify("HEAD"), join(reviewedRoot, "sub"))), false);
    } finally {
      rmSync(cwdRepo, { recursive: true, force: true });
      rmSync(reviewedRoot, { recursive: true, force: true });
    }
  });

  it("marks changed untracked files as stale after review", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "diff-review-untracked-stale-"));
    try {
      git(repoDir, "git init -q");
      writeFileSync(join(repoDir, "a.txt"), "one\n");

      await runDiffReview(repoDir, [" ", "\x1b"]);

      const saved = JSON.parse(readFileSync(statePath(slugify("HEAD"), repoDir), "utf-8"));
      const reviewedHash = saved.reviewed["a.txt"]?.hash;
      writeFileSync(join(repoDir, "a.txt"), "one\ntwo\n");

      const output = await runDiffReview(repoDir, ["\x1b"]);
      const actualHash = git(repoDir, "git hash-object a.txt");

      assert.notEqual(reviewedHash, "");
      assert.notEqual(reviewedHash, actualHash);
      assert.match(output, /1 stale/);
      assert.doesNotMatch(output, /\.pi\/diff-review/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("saves a real file hash for newly reviewed tracked files", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "diff-review-"));
    try {
      git(repoDir, "git init -q");
      git(repoDir, "git config user.email test@example.com");
      git(repoDir, "git config user.name Test");
      writeFileSync(join(repoDir, "a.txt"), "one\n");
      git(repoDir, "git add a.txt");
      git(repoDir, "git commit -q -m init");
      writeFileSync(join(repoDir, "a.txt"), "one\ntwo\n");

      await runDiffReview(repoDir, [" ", "\x1b"]);

      const saved = JSON.parse(readFileSync(statePath(slugify("HEAD"), repoDir), "utf-8"));
      const actualHash = git(repoDir, "git hash-object a.txt");
      assert.equal(saved.reviewed["a.txt"]?.hash, actualHash);
      assert.notEqual(saved.reviewed["a.txt"]?.hash, "");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
