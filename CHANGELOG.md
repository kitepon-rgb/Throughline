# Changelog

All notable changes to Throughline are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-`0.3.18` iteration history is preserved as a rollup section near the bottom
since most of those releases were rapid-fire monitor render bug fixes that
shipped to npm but were not individually tagged on GitHub.

## [0.3.22] — 2026-04-19

### Changed
- Register the `Stop` hook with `"async": true` so `throughline process-turn`
  runs in the background and no longer blocks the user-visible turn completion
  on the Haiku L1-summarization subprocess (which can take seconds to tens of
  seconds). L1 summaries are only needed for the *next* `SessionStart`
  injection, so there is no reason to make the current turn wait for them.
  `SessionStart` and `UserPromptSubmit` remain synchronous because their work
  must complete before the next turn begins.

### Migration
- Existing installs need `throughline uninstall && throughline install` to
  pick up the new `async` flag. The install dedup compares the `command`
  string, so a re-install without uninstalling first will skip the already-
  registered (but still synchronous) entry.

## [0.3.21] — 2026-04-19

### Changed
- `throughline install` now writes the `/tl` and `/sc-detail` slash command
  definitions to `~/.claude/commands/*.md` (user scope) instead of relying on
  per-project `.claude/commands/`. New projects no longer need to copy the
  slash command files manually.

## [0.3.20] — 2026-04-19

### Changed
- Monitor's context-exhaustion warning now recommends `/tl` instead of
  `/clear`, so the suggested action does not break the handoff baton path.

## [0.3.19] — 2026-04-18

### Added
- `ensureMonitorTaskFile` now emits a one-time `<system-reminder>` to stdout
  the moment it creates or merges a `.vscode/tasks.json`, so Claude can tell
  the user a **Developer: Reload Window** is needed to activate the
  `folderOpen` task. The notice is silent on the `already_present` path so it
  fires at most once per project.

## [0.3.18] — 2026-04-18

### Added
- Fan-out of `ensureMonitorTaskFile` to **all three hooks** (`SessionStart`,
  `UserPromptSubmit`, `Stop`) so `.vscode/tasks.json` is provisioned by
  whichever hook fires first in a given environment. Previously only `Stop`
  invoked it, which meant projects where `Stop` did not fire on the first
  session never got the monitor task. The provisioning logic is idempotent,
  so the redundant calls are no-ops once the task exists.

## [0.3.0] — 2026-04-18

This is the first release line that supports the schema v7 / `/tl` baton
handoff with in-flight memo and L3 thinking storage. `0.3.1` through `0.3.17`
were rapid-fire monitor render-bug iterations published to npm but not tagged
on GitHub; they are summarized in the rollup section below for completeness.

### Added
- **In-flight memo via `/tl`** (schema v7). When `/tl` fires, the
  `UserPromptSubmit` hook writes a baton row, then Claude itself pipes a
  Markdown memo (next planned move, current hypothesis, open questions,
  in-progress TODOs) into `throughline save-inflight`, which attaches it to
  `handoff_batons.memo_text`. The next `SessionStart` injects the memo at the
  top of the resume context so the new Claude picks up mid-thought.
- **Extended thinking captured at L3.** Assistant `thinking` blocks are
  persisted in `details` with `kind='thinking'`. The most recent turn's
  thinking is injected inline above the L2 history on `SessionStart`; older
  thinking remains retrievable via `throughline detail <time>`.
- **Resume reframing.** The injected context is presented as "resuming an
  interrupted task" rather than "reading past logs", so the new session
  behaves like a continuation rather than a recap.

## [0.2.0] — 2026-04-18

### Added
- **Explicit `/tl` baton handoff** (schema v6). Replaces the auto-inheritance
  heuristics. The previous session writes a baton, the next session consumes
  it within a 1-hour TTL, and merge happens via deterministic
  `UPDATE session_id = ?` inside a `BEGIN IMMEDIATE` transaction. Sessions
  without a baton start clean — no false-positive carryover.

## [0.1.0] — 2026-04-17

### Added
- Initial public release on npm. Schema v5 (L1/L2/L3 with `kind` and
  `source_id` columns on `details`).
- CLI: `install`, `uninstall`, `doctor`, `status`, `monitor`, `detail`.
- Hook entry points: `session-start`, `process-turn`, `prompt-submit`.
- Multi-session token monitor reading real `message.usage` from the
  Claude Code transcript JSONL (no `length / 4` heuristics) with 1M-context
  detection.
- Zero runtime dependencies; uses Node 22.5+ built-in `node:sqlite`.

---

## Unreleased pre-0.3.18 iterations (npm-only, not tagged on GitHub)

These versions shipped to npm in rapid succession on 2026-04-18 while
debugging a single class of monitor render bugs (rows stacking instead of
redrawing in place inside Windows ConPTY + VS Code task terminals). They are
rolled up here because individually they are not interesting consumption
units — the user-visible result is "the monitor finally renders correctly
across PTY, ConPTY, VS Code task terminal, and panel resize".

| Version | Theme |
| ------- | ----- |
| `0.3.1`–`0.3.2`     | Monitor crash resilience, accurate 1M-context detection, color-blind-safe markers. |
| `0.3.3`             | `.vscode/tasks.json` auto-provisioning (two-stage merge, JSONC detection). |
| `0.3.4`–`0.3.5`     | Stop-hook `state.usage` snapshot, `doctor --session` diagnostic, `(Nm ago)` per-row stamp, columns polling. |
| `0.3.6`–`0.3.12`    | Successive guesses at the "rows stacking" render bug (columns fallback, `isTTY` branching, `clearScreen`, alt screen, `type:shell`). All later confirmed off-target by the `--diag` instrumentation added in `0.3.11`. |
| `0.3.13`            | Root-cause fix: removed the `>= 40` columns floor in `resolveColumns` that was misclassifying real 30-cell panels as "insane" and falling back to 200, which then wrapped output and undercounted CUU on redraw. |
| `0.3.14`–`0.3.15`   | Diagnostic surfacing (startup header, per-frame columns) confirming that `process.stdout.columns` does not track panel resize on Windows ConPTY + VS Code tasks. |
| `0.3.16`            | New module `src/terminal-size.mjs`: query the terminal directly via OSC 18t (`\x1b[18t`) and parse the `\x1b[8;rows;cols t` reply on stdin in raw mode. Resize now follows panel width even when Node's `columns` is frozen. |
| `0.3.17`            | Force a full `clearScreen` (`\x1b[2J\x1b[3J\x1b[H`) on every resize-triggered redraw so the previous, wrongly-sized frame can no longer stack beneath the new one. |

### Lessons preserved as memory

The seven-version stretch of `0.3.6`–`0.3.12` was guesswork without
measurement; once `--diag` (`0.3.11`) and `terminal-size.mjs` (`0.3.16`) were
added, the real cause was found in two more versions. This is recorded as a
working-discipline note: when a terminal- or platform-specific bug resists
two attempts, instrument first instead of patching again.

---

[0.3.22]: https://github.com/kitepon-rgb/Throughline/releases/tag/v0.3.22
[0.3.21]: https://github.com/kitepon-rgb/Throughline/compare/v0.3.19...v0.3.21
[0.3.20]: https://github.com/kitepon-rgb/Throughline/compare/v0.3.19...v0.3.20
[0.3.19]: https://github.com/kitepon-rgb/Throughline/releases/tag/v0.3.19
[0.3.18]: https://github.com/kitepon-rgb/Throughline/releases/tag/v0.3.18
[0.3.0]: https://github.com/kitepon-rgb/Throughline/releases/tag/v0.3.0
[0.2.0]: https://github.com/kitepon-rgb/Throughline/releases/tag/v0.2.0
[0.1.0]: https://github.com/kitepon-rgb/Throughline/compare/v0.1.0
