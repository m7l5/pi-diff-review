/**
 * Tests for diff-parser.ts — unified diff parsing
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDiff } from "../diff-parser.js";

describe("parseDiff", () => {
  it("returns empty array for empty input", () => {
    assert.deepStrictEqual(parseDiff(""), []);
  });

  it("parses a single file with one hunk", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line one
+added line
 line two
 line three`;

    const result = parseDiff(diff);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].path, "src/foo.ts");
    assert.strictEqual(result[0].isBinary, false);
    assert.strictEqual(result[0].hunks.length, 1);
    assert.strictEqual(result[0].stats.added, 1);
    assert.strictEqual(result[0].stats.removed, 0);
  });

  it("parses multiple files", () => {
    const diff = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
-a
+aa
 b
diff --git a/b.ts b/b.ts
index 333..444 100644
--- a/b.ts
+++ b/b.ts
@@ -1,1 +1,1 @@
-old
+new`;

    const result = parseDiff(diff);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].path, "a.ts");
    assert.strictEqual(result[1].path, "b.ts");
  });

  it("detects binary files", () => {
    const diff = `diff --git a/icon.png b/icon.png
Binary files a/icon.png and b/icon.png differ`;

    const result = parseDiff(diff);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].path, "icon.png");
    assert.strictEqual(result[0].isBinary, true);
    assert.strictEqual(result[0].hunks.length, 0);
  });

  it("computes stats correctly", () => {
    const diff = `diff --git a/x.ts b/x.ts
index 111..222 100644
--- a/x.ts
+++ b/x.ts
@@ -1,5 +1,4 @@
-removed1
-removed2
+added1
 context1
 context2
-removed3`;

    const result = parseDiff(diff);
    assert.strictEqual(result[0].stats.added, 1);
    assert.strictEqual(result[0].stats.removed, 3);
  });

  it("handles multiple hunks in one file", () => {
    const diff = `diff --git a/f.ts b/f.ts
index 111..222 100644
--- a/f.ts
+++ b/f.ts
@@ -1,3 +1,4 @@
 a
+added1
 b
 c
@@ -10,2 +11,2 @@
-old
+new
 x`;

    const result = parseDiff(diff);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].hunks.length, 2);
  });

  it("detects file types: added, deleted, modified", () => {
    const added = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+hello
+world`;

    const deleted = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index abc1234..0000000
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-world`;

    assert.strictEqual(parseDiff(added)[0].fileType, "added");
    assert.strictEqual(parseDiff(deleted)[0].fileType, "deleted");
    assert.strictEqual(
      parseDiff("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-old\n+new")[0]
        .fileType,
      "modified",
    );
  });
});
