# pi-diff-review

Interactive git diff review inside [Pi](https://github.com/badlogic/pi-mono) — check files as reviewed, leave hunk-level comments, compile review notes, and discuss changes with AI.

## Install

```bash
pi install pi-diff-review
```

Or manually:

```bash
git clone https://github.com/your-org/pi-diff-review.git ~/.pi/agent/extensions/diff-review
```

## Usage

```
/diff-review                        → git diff main...HEAD
/diff-review HEAD...main            → git diff HEAD...main (what main has)
/diff-review origin/main            → git diff origin/main
/diff-review HEAD~5                 → git diff HEAD~5 (last 5 commits)
/diff-review --cached               → git diff --cached (staged changes)
/diff-review @~/other-repo          → git diff HEAD in another repo
/diff-review origin/main @~/repo    → explicit target + repo
```

## Keybindings

| Key                | Action                     |
| ------------------ | -------------------------- |
| `↓↑` / `PgUp/PgDn` | Scroll hunk                |
| `j/k`              | Jump between hunks         |
| `Tab`              | Next file                  |
| `Space`            | Toggle reviewed            |
| `c`                | Comment on current hunk    |
| `C` / `Enter`      | Compile comments + close   |
| `v`                | Toggle pending / all files |
| `/`                | Search files               |
| `h`                | Select hunk for context    |
| `g/G`              | First / last file          |
| `r`                | Reset all reviews          |
| `Esc`              | Close                      |

## Development

```bash
pnpm install
pnpm typecheck        # TypeScript check
pnpm build            # Compile to dist/
pnpm test             # Run tests
pnpm lint             # oxlint
pnpm format           # oxfmt
```

## License

Apache-2.0
