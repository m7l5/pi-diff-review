# pi-diff-review

Interactive git diff review inside [Pi](https://github.com/badlogic/pi-mono) — check files as reviewed, leave hunk-level comments, compile review notes, and discuss changes with AI.

## Install

Install directly from GitHub with Pi:

```bash
pi install git:github.com/m7l5/pi-diff-review
```

Or, if you prefer SSH:

```bash
pi install git:git@github.com:m7l5/pi-diff-review
```

Then run `/diff-review` from inside any git repo.

## Usage

```
/diff-review                        → git diff HEAD in current Pi folder
/diff-review HEAD...main            → git diff HEAD...main (what main has)
/diff-review origin/main            → git diff origin/main
/diff-review HEAD~5                 → git diff HEAD~5 (last 5 commits)
/diff-review --cached               → git diff --cached (staged changes)
/diff-review ~/other-repo           → git diff HEAD in another repo
/diff-review ~/repo origin/main     → git diff origin/main in another repo
/diff-review ~/repo HEAD~2...origin/main
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
| `g/G`              | First / last file          |
| `r`                | Reset all reviews          |
| `Esc`              | Close                      |

In compile mode, use `↑↓` / `j/k` to move between comments and `d`, `Delete`, or `Backspace` to remove the selected comment before injecting.

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
