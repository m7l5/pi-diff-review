/**
 * Tests for state.ts — slug generation and path helpers
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { slugify, statePath } from "../state.js";

describe("slugify", () => {
  it("handles main...HEAD", () => assert.strictEqual(slugify("main...HEAD"), "main-head"));
  it("handles HEAD...main", () => assert.strictEqual(slugify("HEAD...main"), "head-main"));
  it("handles branch with slash", () => assert.strictEqual(slugify("origin/main"), "origin-main"));
  it("handles commit-ish", () => assert.strictEqual(slugify("HEAD~5"), "head-5"));
  it("handles --cached", () => assert.strictEqual(slugify("--cached"), "cached"));
  it("handles stash ref", () => assert.strictEqual(slugify("stash@{0}"), "stash-0"));
  it("collapses multiple separators", () => assert.strictEqual(slugify("a//b..c"), "a-b-c"));
  it("trims leading/trailing dashes", () => assert.strictEqual(slugify("---cached---"), "cached"));
  it("lowercases", () => assert.strictEqual(slugify("Main...HEAD"), "main-head"));
});

describe("statePath", () => {
  it("generates path in .pi/diff-review/", () => {
    const p = statePath("main-head", "/repo");
    assert.strictEqual(p, "/repo/.pi/diff-review/main-head.json");
  });
  it("handles empty slug", () => {
    const p = statePath("", "/repo");
    assert.strictEqual(p, "/repo/.pi/diff-review/.json");
  });
});
