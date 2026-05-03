/** State management — slug generation and file path helpers. Pure functions. */

/**
 * Slugify a git diff target into a safe filename fragment.
 * Replace /, ~, ., spaces with -, collapse multiples, strip edges.
 *
 * @example
 *   slugify("main...HEAD")  → "main-head"
 *   slugify("origin/main")  → "origin-main"
 *   slugify("--cached")     → "cached"
 */
export function slugify(target: string): string {
  return target
    .replace(/[/~.{}@\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/**
 * Generate the full temp path for a review state file.
 */
export function statePath(slug: string, repoRoot: string): string {
  return `${repoRoot}/.pi/diff-review/${slug}.json`;
}
