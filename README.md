# Prettify — Pi Coding Agent Input Field Extension

Decorates the Pi editor input area with a styled frame or bar, plus live stats: model, session summary, mode, thinking level, tokens/sec, cost, context window usage, cwd, git status, and version.

## Quick Start

```bash
pi -e ./prettify.ts
```

## Flavors

Two visual styles. Switch with `/prettify`:

| Command | Result |
|---|---|
| `/prettify frame` | Full box-drawing frame (╭─╮╰─╯) |
| `/prettify bar` | Left thick block bar (█) |

Default is `frame`.

## Stats

Ten stat groups, each togglable per-session:

| Key | Display |
|---|---|
| `model` | Model ID + provider (top-left) |
| `session` | Session name or first user message summary (top-right) |
| `mode` | `plan` or `exec` (bottom-left) |
| `thinking` | Thinking level / "off" (bottom-left) |
| `tps` | Tokens per second (bottom-right) |
| `cost` | Cumulative session cost in $ (bottom-right) |
| `context` | Context window fill % + progress bar (bottom-right) |
| `cwd` | Current working directory, ~-expanded (footer left) |
| `git` | Branch, state, status glyphs (footer left) |
| `version` | `pi v0.79.1` (footer right) |

All colors come from the active theme. Mode uses accent/warning; context bar uses success → warning → error thresholds (50% / 80%).

### Toggle visibility

```
/prettify show <stat>
/prettify hide <stat>
```

Show all again by reloading. List current state with no arguments:

```
/prettify
```

Output example: `prettify: frame mode | visible: model, session, mode, thinking, tps, cost, context, cwd, git, version`

## Layout

Both flavors share the same stat positions:

```
╭ model_id (provider)         ── session summary ─────────╮
│ > user prompt text...                                    │
│   continuation lines...                                  │
╰ plan · thinking off    ── 42 t/s · 0.012$ · 23% ━━───────╯
  ~/code/project  main ⇡2 +3 !1 ~1  pi v0.79.1
```

Frame: box-drawing characters with mode-colored borders and gutter.
Bar: single █ column on left, dark-grey background fill across the rest.

## Git Status

Starship-inspired glyphs. Edit `GIT_SYMBOLS` in-source to customize:

| Glyph | Meaning |
|---|---|
| `⇡N` | Ahead of remote by N commits |
| `⇣N` | Behind remote by N commits |
| `+N` | Staged changes |
| `!N` | Modified tracked files |
| `»N` | Renamed files |
| `󰧧N` | Deleted files |
| `󱀣N` | Untracked files |
| `󱠇N` | Conflicted files |
| `*N` | Stashed changes |
| `REBASING`, `MERGING`, etc. | Active git operation state |

Auto-refreshes on session start, agent end, and branch change.

## Architecture

Wraps (doesn't replace) whatever editor component is installed at session start. This means it composes with other extensions like `raw-paste` — each extension's editor gets decorated by prettify rather than fighting for sole control.

Marked with `__prettify` to prevent double-wrapping across `/reload`.

## Load Path

```typescript
// pi -e ./prettify.ts
export default function (pi: ExtensionAPI) { ... }
```

Requires:
- `@earendil-works/pi-coding-agent` (ExtensionAPI, CustomEditor)
- `@earendil-works/pi-tui` (EditorComponent, truncateToWidth, visibleWidth)
- `@earendil-works/pi-ai` (ThinkingLevel)
- Node.js `fs.existsSync`, `path.join`
