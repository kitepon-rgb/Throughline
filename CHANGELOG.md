# Changelog

All notable changes to Throughline are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-`0.3.18` iteration history is preserved as a rollup section near the bottom
since most of those releases were rapid-fire monitor render bug fixes that
shipped to npm but were not individually tagged on GitHub.

## [Unreleased]

### Added
- Claude-primary / Codex-sidecar groundwork:
  `HandoffRecord` projection, `throughline handoff-preview`,
  `throughline_handoff` example context, and `codex-sidecar-diagnostics` /
  `codex-sidecar-dry-run` command surfaces.
- Optional `codex-sidecar` L2→L1 summarization path. When the sidecar is
  configured for the `summarize-l1` preset, Throughline uses it for the only
  subagent-like external model call; disabled/unavailable/run-failed sidecar
  states keep the existing Claude Haiku route.
- `/tl-trim` dry-run surface:
  `throughline trim --dry-run`, `--host`, `--keep-recent`, `--all`,
  `--memo-stdin`, and `throughline doctor --trim`.

### Changed
- Resume context now frames recent L2 as an active work thread with explicit
  reading/continuation instructions at both the top and bottom of injected
  memory. Older L2 entries may be superseded by later entries and are not
  blindly treated as still-current truth.
- Hook entry modules are import-safe and expose `run()` so subprocess tests can
  cover the Claude path without touching the user's real database.
- VSCode task tests suppress Claude-facing `<system-reminder>` notices by
  default and opt in only for notice assertions, keeping test output from
  looking like fresh user-facing instructions.
- `codex-sidecar` subprocess calls now shell-wrap on Windows so npm global
  `.cmd` shims resolve consistently, matching the existing Claude CLI handling.
- L2→L1 sidecar summarization accepts the stable `SidecarResult` JSON shape
  (`summary` without `status: "ok"`) as well as the older test fixture shape.
- `codex-sidecar-dry-run --turn-timeout-ms` now forwards the timeout into the
  normalized sidecar request instead of only changing the local subprocess
  timeout.
- `.codex-sidecar.yml` no longer denies every path containing `token`, so
  legitimate source files such as `src/token-monitor.mjs` remain reviewable.
- `.codex-sidecar.yml` allows release docs and Claude slash commands, so
  review/risk-check sidecars can inspect the same contract surfaces that are
  shipped in the npm tarball.
- `.codex-sidecar/logs/` is ignored as a runtime artifact from real sidecar
  smoke runs.
- Codex trim host status now distinguishes verified app-server rollback/inject
  primitives from the still-unimplemented Throughline automatic trim execution.

### Documentation
- Added integrated implementation/TODO plan and cross-links for the Codex dual
  support and rollback trim design docs.
- README now documents Claude-primary behavior, optional Codex sidecar usage,
  and the current dry-run-only state of context trim.
- npm packaging now includes `docs/` and `CHANGELOG.md`, so README-linked
  design docs and the `throughline_handoff` example context are present in the
  tarball.
- npm packaging also includes `.codex-sidecar.yml`, keeping the documented
  sidecar diagnostics / dry-run examples reproducible from the package source.
- `npm test` now includes nested `src/cli/*.test.mjs` coverage in addition to
  the top-level `src/*.test.mjs` tests.
- Recorded the 2026-05-06 Codex app-server rollback/inject spike: `thread/read`
  can read persisted threads, `thread/rollback` requires a loaded thread via
  `thread/resume`, and injected developer items are visible to the next turn.

## [0.3.24] — 2026-05-02

### Added
- `shouldRecommendGitignore` in [src/vscode-task.mjs](src/vscode-task.mjs):
  when `ensureMonitorTaskFile` transitions to `created` / `merged` / `repaired`
  inside a git repository whose `.gitignore` lacks a `.vscode/tasks.json`-
  matching entry, emit a one-time `<system-reminder>` to stdout recommending
  `.gitignore` registration. Suppressed by a `.throughline-gitignore-noted`
  marker so it does not repeat. Negation patterns (`!.vscode/tasks.json`) are
  treated as explicit-track intent and still trigger the recommendation.

### Why
- `.vscode/tasks.json` always contains environment-specific absolute paths
  (`process.execPath`, the install location of `throughline.mjs`). Even though
  v0.3.23 auto-repairs stale paths after the fact, the right answer is to not
  commit it in the first place. The published npm tarball was already clean of
  absolute paths (`files` field excludes `.vscode/`, no hardcoded paths in
  source); this release strengthens runtime advice for the consumer side.

## [0.3.23] — 2026-05-02

### Added
- Cross-environment `.vscode/tasks.json` repair: when an existing Monitor task
  references absolute paths that don't exist on the current machine
  (e.g. a Windows path on a WSL2 clone), `ensureMonitorTaskFile` now rewrites
  just `command` / `args` while preserving any `label` / `presentation` /
  `isBackground` customization. New helpers `findMonitorTaskIndex` and
  `isMonitorTaskBroken` (absolute-path + non-existent test) drive the new
  `action: 'repaired'` branch, and `buildSetupNotice('repaired')` returns a
  one-time `Reload Window` notice.
- `resolveThroughlineOnPath` in [src/cli/install.mjs](src/cli/install.mjs):
  after `throughline install` completes, walk PATH to confirm `throughline`
  resolves. If not, print a stderr fix recipe (`npm prefix -g` → add to
  `~/.bashrc` → re-run `doctor`). Catches the silent-fail case where
  `~/.npm-global/bin` is exported in `~/.profile` but not `~/.bashrc` (VSCode's
  interactive non-login bash skips `.profile`).

### Documentation
- README Troubleshooting now covers PATH resolution, WSL2 ↔ Windows PATH
  crossover, cross-OS DB separation (each `os.homedir()` is its own DB), and
  the auto-repair behavior for stale tasks.

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
