# Changelog

All notable changes to Throughline are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-`0.3.18` iteration history is preserved as a rollup section near the bottom
since most of those releases were rapid-fire monitor render bug fixes that
shipped to npm but were not individually tagged on GitHub.

## [Unreleased]

## [0.3.25] — 2026-05-08

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
  `--memo-stdin`, `--codex-thread-id`, and `throughline doctor --trim`.
- Codex app-server protocol helpers for the verified trim flow: newline JSON
  framing, initialize / resume / rollback / inject / turn-start request
  builders, and parser coverage.
- Codex rollout-backed trim source for explicit `--codex-thread-id` plans.
  This lets Codex dry-run / preflight / guarded execute use the active rollout
  even when the Throughline DB has no Codex `bodies` rows.
- `throughline codex-capture`, which captures explicit Codex rollout active
  turns into a namespaced `codex:<thread_id>` Throughline DB session. Re-capture
  rebuilds that session so rolled-back tail turns do not survive as current L2.
- Codex capture now stores rollout function-call L3 details as well as L2
  bodies: `function_call` becomes `details.kind = tool_input`, and
  `function_call_output` becomes `details.kind = tool_output`.
- Host-mode L2→L1 backend selection. Claude-primary keeps the existing
  `codex-sidecar` / Claude Haiku compatibility route, while Codex-primary uses
  the Codex CLI backend and reports failure explicitly instead of falling back.
- `throughline codex-summarize`, which writes L1 skeletons for captured
  `codex:<thread_id>` sessions through the Codex CLI backend once the captured
  body count exceeds the L2 window.
- `throughline codex-resume`, which renders captured `codex:<thread_id>` memory
  as Codex active-work context. `--format handoff` emits a concise fresh-thread
  handoff prompt for safe continuation without mutating the current Codex
  thread; the handoff view caps recent L2 entries, long body text, and detail
  references while preserving the full context in the normal text renderer.
  `--format item-json` emits a Codex developer message item so hosts can
  inject the memory as current-task context instead of a passive archive.
  `--memo-stdin` prepends a Codex-primary in-flight memo without touching Claude
  `/tl` batons.
- `throughline codex-handoff-smoke`, a read-only validator for the
  `codex-resume --format handoff` prompt. It checks fresh-thread header /
  current-task contract / source session / start instruction / mutation
  boundary / prompt size / detail-command deduplication before a user starts a
  new Codex thread with that prompt.
- `throughline codex-handoff-model-smoke`, an explicit opt-in model smoke for
  the same handoff prompt. It first requires the structural handoff smoke to be
  ready, then runs `codex exec --ephemeral --ignore-user-config --ignore-rules
  --sandbox read-only` with a marker prompt. `--dry-run` inspects the exact
  readiness / command boundary without starting Codex exec, and
  `--print-prompt` can include the combined prompt for audit. Live model smoke
  requires `THROUGHLINE_EXPERIMENTAL_CODEX_HANDOFF_MODEL_SMOKE=1` and does not
  mutate the current Codex thread.
- `throughline codex-handoff-start`, a guided read-only fresh-thread start plan
  for Codex handoff. It reports the structural smoke command, model-smoke dry-run
  boundary, handoff render command, optional live model smoke command, and can
  include the handoff prompt with `--print-prompt`. When `--memo-stdin` is used,
  the replay commands include `--memo-stdin` and the output reminds callers to
  pipe the same memo.
- `throughline doctor --codex`, a read-only Codex-primary diagnostic that shows
  current thread env identity, rollout candidates for the cwd, captured
  `codex:<thread_id>` DB sessions, context refresh blockage, new-thread
  handoff readiness, and the next capture/resume commands.
- Global `throughline install` now also registers the Codex Stop hook in
  `~/.codex/hooks.json` with absolute node + installed `bin/throughline.mjs`,
  `async: false`, and `timeoutSec: 300`, and enables
  `[features].codex_hooks = true` in `~/.codex/config.toml`. Existing non-
  Throughline Codex hooks, including Caveat / Spotter hooks, are preserved.
- Global install now also installs a `$throughline` Codex skill under
  `~/.codex/skills/throughline`, giving Codex a natural-language entrypoint for
  Throughline status, resume, summarize, dry-run, preflight, and explicit
  execute workflows. The rollback / inject execute path is enabled again after
  controlled rollback model-visible smokes failed to reproduce rollback marker
  resurrection.
- A bare `$throughline` Codex skill invocation now runs the safe inspection
  shape: `doctor --codex`, guarded dry-run, and preflight. Explicit
  `trim --execute --host codex --all` mutates the current Codex thread when the
  user asks for it and the guard checks pass.
- Codex Stop hook automatic refresh now attempts guarded rollback + Throughline
  DB memory injection at the 90% verified-usage threshold. Estimate-only usage
  still never triggers mutation.
- `throughline codex-visibility-smoke`, an experimental opt-in Codex app-server
  smoke that injects the Codex active-work developer message and starts a
  marker-check model turn. It requires
  `THROUGHLINE_EXPERIMENTAL_CODEX_MODEL_VISIBLE_SMOKE=1` and supports explicit
  model-turn timeouts with `--request-timeout-ms` / `--timeout-ms`; it also
  accepts the same `--memo-stdin` active-work memo surface as `codex-resume`.
  `--resume-after-inject` re-runs `thread/resume` after injection before
  starting the marker turn, so resume persistence can be checked explicitly.
- Codex-first roadmap docs that set the next implementation order: Codex
  primary support with a Codex CLI L2→L1 backend, then Codex rewind-compatible
  trim, then Claude rewind finalization.

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
  primitives from guarded execution requirements. Codex Stop hook automatic
  refresh is enabled only at the 90% verified-usage threshold and still uses the
  same explicit thread identity, injectable DB memory, and rollout/app-server
  turn-count guards.
- Trim dry-run now carries an explicit Codex thread identity separately from
  the Claude/Throughline `session_id`, avoiding latest-rollout guessing.
- Codex trim can now use `THROUGHLINE_CODEX_THREAD_ID` or `CODEX_THREAD_ID` as
  a current-thread identity signal when `--codex-thread-id` is omitted; the CLI
  flag remains authoritative and Throughline still does not guess from the
  latest rollout.
- `throughline doctor --trim --host codex` now reports whether a current Codex
  thread id is available from env and adjusts its dry-run example accordingly.
- `throughline doctor --trim --host codex` now also reports the read-only host
  primitive audit status as diagnostic evidence rather than an execute blocker.
- `throughline trim --preflight --host codex --codex-thread-id <id>` now
  performs a guarded Codex app-server initialize/read/resume check and stops
  before sending rollback or inject. When the plan source is `codex-rollout`,
  preflight compares rollout active turns with app-server read/resume turns and
  refuses the plan if they differ.
- Codex rollout-backed trim source now excludes the current in-flight turn from
  rollback planning, including the latest post-rollback assistant continuation.
  This keeps preflight aligned with app-server `thread/read` / `thread/resume`,
  which only report completed host-visible turns during an ongoing Codex turn.
- `throughline trim --execute --host codex --codex-thread-id <id>` no longer
  requires `THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE=1` and no longer treats
  host primitive audit or restore-safety diagnostics as mutation blockers.
  Execute still refuses before mutation when Codex thread identity, injectable
  Throughline DB memory, or rollout/app-server turn-count agreement is missing.
- Codex guarded execute now polls post-inject `thread/read` until the injected
  memory item is visible when the app-server reports an injected turn count, and
  reports `postInjectVisibilityCheck` so stale immediate app-server reads are
  explicit. If `thread/inject_items` returns no turn list, developer memory is
  treated as item-level injection and the expected post-inject turn count remains
  the rollback result turn count.
- Codex guarded execute status now separates live mutation from durable
  success: a visible app-server mutation reports `execute-sent-live-only` with
  `durableVerification.durableVerified: false` and exits non-zero; post-inject
  visibility timeout reports `execute-unverified`.
- Codex guarded execute can now report `execute-durable-verified` only when the
  rollout records a new `thread_rolled_back` event, records the injected
  `## Throughline: Active Work Context` memory, and restore-safety diagnostics
  remain `ok`.
- Added `throughline codex-restore-smoke`, a read-only diagnostic that starts
  fresh Codex app-server processes and compares `thread/read`,
  `thread/resume`, and paginated `thread/turns/list` turn counts against the
  rollout active turn count. Its proof scope is
  `app_server_process_restart_only`, and it always reports `restartSafe: false`
  because it is not VS Code restart / reconnect proof. If the required
  read-only app-server request fails, the CLI returns structured
  `app-server-restore-smoke-error` JSON instead of a stack trace.
- `codex-restore-smoke --inspect-risky-rollout` can now inspect a risky rollout
  read-only and search app-server responses for retained rollback text. If
  retained text appears in direct turn text or `replacement_history`, the smoke
  reports `app-server-restore-text-retained` instead of a success-like stable
  status, even when read/resume/list turn counts are stable. If retained text
  appears only in quoted/tool-output fields such as `aggregatedOutput`, it
  reports `app-server-restore-text-quoted`. Match reports include sample JSON
  paths, location kinds, risk classes, and blocking-candidate summaries.
- `codex-vscode-rollback-smoke` text output now includes retained rollback text
  count, resurrected user message count, and restore-safety risk type summary so
  incident audits do not require opening the full JSON payload.
- `codex-restore-source-audit` now inventories SQLite-backed VS Code storage
  candidates (`.vscdb`, `.sqlite`, `.sqlite3`, `.db`) read-only and reports
  table / searchable column / needle match summaries alongside raw byte matches.
- `codex-restore-source-audit` now classifies VS Code log evidence into thread
  id hits, retained rollback text hits, patch-apply failures, thread stream
  broadcasts, and `replacement_history` signals, including a first/last
  timestamp window for patch-apply failures when log timestamps are present.
- `codex-restore-source-audit` now reports explicit VS Code extension
  rollback non-resurrection projection candidates, such as
  `replacement_history` filter / tombstone paths, separately from deletion-based
  repair primitives.
- `codex-restore-smoke --inspect-risky-rollout` now separates blocking retained
  text candidates from quoted/tool-output matches. Direct turn text and
  `replacement_history` keep the `app-server-restore-text-retained` status;
  matches found only in fields such as `aggregatedOutput` report
  `app-server-restore-text-quoted` with `blocking-candidates=no`.
- Added `throughline codex-rollback-model-visible-smoke`, a controlled
  two-phase smoke for the unresolved rollback question. `--prepare` starts a
  unique marker user turn and rolls it back; `--verify` later starts a model
  turn that contains only the marker prefix, not the full marker. A returned
  full marker reports `reproduced`; an explicit not-visible answer reports
  `not-reproduced`. The command is gated by
  `THROUGHLINE_EXPERIMENTAL_CODEX_ROLLBACK_MODEL_VISIBLE_SMOKE=1`. Live runs can
  use `--marker-file` so the full marker is not printed into the same thread
  being tested; marker-file prepares also use a unique per-trial prefix. Verify
  output reports `rolledBackMarkerModelVisible` and `modelReportedNotVisible`
  separately from `restartSafe`.
- Real controlled current-thread smoke on 2026-05-08 returned
  `not-reproduced` both before and after a VS Code reload/reconnect command,
  with `promptIncludesMarker: false` and no observed full marker. This weakens
  the rollback-resurrection hypothesis for the controlled marker path enough to
  remove the overbroad automatic Codex trim blocker. Retained compacted history
  and same-thread host primitive audit remain diagnostics.
- Added `throughline codex-restore-source-audit`, a read-only local inventory of
  Codex rollout, `session_index.jsonl`, `state_*.sqlite`, and VS Code
  globalStorage / workspaceStorage candidates for an explicit Codex thread. It
  now also scans VS Code `settings.json`, VS Code logs, and installed
  OpenAI/Codex VS Code extension bundles for restore-path signals such as
  `thread/read`, `thread/resume`, `thread/turns/list`, reconnect
  `needs_resume`, persisted webview atoms, and follow-up queue signals.
  Its proof scope is `local_restore_source_inventory_only`, and it does not
  prove VS Code restart safety.
- Added `throughline codex-vscode-restore-smoke`, a manual two-phase VS Code
  reload/reconnect proof protocol. `--prepare` injects a hidden active-work
  marker memory behind `THROUGHLINE_EXPERIMENTAL_CODEX_VSCODE_RESTORE_SMOKE=1`;
  `--verify` scans the rollout for a marker-free smoke prompt followed by an
  assistant marker-only answer after prepare, and rejects marker leaks in the
  user prompt. It reports `restartSafe: true` only with an explicit
  `--after-vscode-restart` acknowledgement and marker proof.
- Real VS Code reload/reconnect marker proof passed for thread
  `019dfddb-8288-7392-a461-bf3ebc5da409` with marker
  `TL_CODEX_VSCODE_RESTORE_46888202`. This proves hidden developer memory
  visibility across reconnect, not rollback-target non-resurrection.
- Tightened the VS Code restore smoke verifier after a false-positive hazard:
  assistant marker mentions in normal progress text no longer count. The proof
  now requires the marker-free smoke prompt and an assistant marker-only answer.
- Added `throughline codex-vscode-rollback-smoke`, a read-only rollback
  non-resurrection verifier. It requires a rollback event, rolled-back user
  text, a later user turn, restore-safety `ok`, and explicit
  `--after-vscode-restart` before reporting `restartSafe: true`.
- Added `throughline codex-host-primitive-audit`, a read-only audit that
  generates the installed Codex app-server JSON schema and checks whether a
  same-thread rollback non-resurrection primitive exists. The primitive may
  delete/rewrite retained rollback sources, or isolate/project them away from
  model-visible input. It now also reports a host-agnostic same-thread repair
  contract requiring a rollback non-resurrection guarantee, memory reinjection,
  post-repair host reads, and restart/reconnect non-resurrection proof; VS Code
  diagnostics can provide evidence but do not satisfy the contract. On
  `codex-cli 0.128.0-alpha.1`, the audit reports
  `diagnostic-only`: rollback/inject/new-thread primitives exist, but no
  current-thread rollback non-resurrection primitive is exposed, and
  `thread/resume(history)` is marked unstable/do-not-use with `thread_id`
  ignored.
- Real incident-shaped live rollback run for thread
  `019dfddb-8288-7392-a461-bf3ebc5da409` remains a `restoreSafety: risk`
  incident: rollout recorded `thread_rolled_back` and injected active-work
  memory, while `compacted.replacement_history` retained rollback-targeted user
  text and read-only diagnostics later observed matching text after rollback.
  Later app-server restore inspection separated direct user-message candidates
  from quoted/tool-output matches; the current thread's retained app-server
  matches are `aggregatedOutput` only, and the controlled model-visible smoke
  did not reproduce marker resurrection. Automatic Codex trim is enabled again
  with DB memory and turn-count guards.
- Codex trim dry-run plans and `doctor --trim --host codex` now expose the safe
  continuation path as `new-thread-handoff-only`: use the guided entrypoint
  `throughline codex-handoff-start --session codex:<thread-id>`, or validate the
  handoff with `throughline codex-handoff-smoke --session codex:<thread-id>`, optionally
  inspect the model-smoke boundary with
  `throughline codex-handoff-model-smoke --session codex:<thread-id> --dry-run --json`,
  render a fresh-thread handoff with
  `throughline codex-resume --session codex:<thread-id> --format handoff`, and
  start a new Codex thread, without mutating the current risky thread.
- Human-readable trim dry-run reports now truncate the inline curated memory
  preview for scanability while leaving full `memoryPreview.text` intact in JSON
  and in the Codex `codex-resume` safe-continuation command.
- `parseCodexRolloutFile` now exposes `userMessagesAfterRollback`,
  `latestRollbackAt`, and `restoreSafety.rolledBackTexts` so rollback smoke
  results carry enough audit evidence instead of only pass/fail status.
- Guarded execute now still checks rollout durability evidence when post-inject
  live read visibility times out, so reports can include observed rollback
  markers, observed injected memory, and post-execute restore-safety risk.
- Codex trim preflight / execute now reports planned restore-safety diagnostics:
  if the planned rollback would remove user text that already appears in
  `compacted.replacement_history`, Throughline reports
  `planned_restore_safety_risk` as diagnostic evidence but does not refuse
  solely for that reason.
- `codex-restore-source-audit` no longer uses very short retained rollback texts
  as VS Code storage needles, avoiding false positives from generic prompts such
  as `go`.
- Codex guarded execute no longer uses the old
  `THROUGHLINE_EXPERIMENTAL_CODEX_TRIM=1` gate or the later
  `THROUGHLINE_EXPERIMENTAL_CODEX_TRIM_EXECUTE=1` blocker. It now requires only
  explicit `--execute`, Codex thread identity, injectable Throughline DB memory,
  and rollout/app-server turn-count checks before mutation.
- Codex app-server helpers now report spawn failures explicitly instead of
  waiting for a request timeout.
- Codex app-server stderr in diagnostics is now capped after warning
  compaction, so external plugin/OAuth warnings cannot make smoke JSON
  excessively large.
- `throughline codex-threads` lists read-only Codex rollout/thread candidates
  for the current project so users can pass an explicit `--codex-thread-id`
  without Throughline guessing the active thread.
- `throughline codex-threads` now sorts candidates by rollout file mtime, not
  stale `session_index.jsonl` timestamps, so actively written threads appear
  before old probe threads.
- Codex trim memory previews now apply `thread_rolled_back` rollout events
  before building the active work thread, so rolled-back tail turns are not
  reintroduced as current memory.
- Codex trim dry-run now reports a heuristic context reduction estimate when
  rollout text is available: rollback-candidate estimated tokens, injected
  memory estimated tokens, net estimated reduction, and reduction percentage.
  This is intentionally labeled as `chars / 4`, not an exact host tokenizer
  measurement.
- Codex rollout parsing now mirrors app-server turn counts for injected
  active-work developer messages and for the latest post-rollback assistant
  continuation turn. This keeps guarded trim preflight aligned after a real
  rollback/inject cycle.
- Codex guarded trim now uses rollout/app-server data for rollback planning and
  turn-count guards, but uses Throughline DB memory for injection when
  available: older turns as L1 summaries, the latest 20 turns as full L2 bodies,
  and L3 as references only; L3 bodies / tool payloads are not injected.
  Execute refuses before mutation when only a rollout preview is available.
- `throughline doctor --codex` now reports context-refresh readiness, including
  rollback source, inject memory source, the L1/L2/L3 memory contract, current
  memory counts, and heuristic reduction estimate when available.
- `throughline doctor --codex` now reports the host primitive audit status and
  prints `throughline codex-host-primitive-audit` as the next read-only command
  for diagnostic detail.
- `throughline doctor --codex` labels context refresh as `ready` when the
  executable guard inputs are present, even if restore-safety diagnostics are
  risky. Those diagnostics are reported separately.
- `throughline doctor --codex` now reports the VS Code monitor task status and
  prints the Reload Window note there too, because Codex Stop hook stdout is not
  guaranteed to appear in the chat.
- `throughline doctor --codex` and human-readable guarded trim reports now label
  L3 as references-only and explicitly say L3 bodies are not injected.
- Guarded Codex execute now performs the same rollout/app-server turn-count
  check before rollback; mismatch or unavailable app-server counts refuse
  execution before any rollback or inject request is sent.
- Codex app-server stderr in trim preflight / guarded execute now compacts
  repeated unknown-turn item warnings while preserving the first occurrence and
  unrelated diagnostics.
- Codex visibility smoke now waits for app-server notification events
  (`item/agentMessage/delta` or `turn/completed`) after `turn/start`, so it does
  not mistake an accepted model turn for completed model visibility.
- Codex visibility smoke can now verify the `inject -> resume -> turn/start`
  path. Real-host smoke confirmed marker
  `TL_CODEX_RESUME_AFTER_INJECT_REAL_20260506` after a post-inject resume.
- Codex CLI L1 summarization now uses the `codex exec` option set supported by
  local `codex-cli 0.128.0-alpha.1`; the removed `--ask-for-approval` flag is
  no longer passed. The subprocess also passes `--ignore-user-config` so
  user-level Codex plugins/hooks are not loaded during the summarization call.
- Codex CLI summarization errors now include compacted stderr in JSON output,
  preserving actionable `ERROR:` lines without dumping enormous HTML challenge
  pages verbatim.
- `throughline monitor` is now host-aware for Claude and Codex state files.
  Codex Stop hook writes `codex:<thread_id>` monitor state with `rolloutPath`,
  snapshots verified rollout `token_count` usage when present, and marks
  rollout-text estimates with `estimated: true` / `est` when no token-count
  event is available. State filenames are URL-encoded so `codex:` session ids
  remain portable. The compact row now displays used tokens over the model
  context window, instead of percent plus remaining tokens.

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
- Recorded the 2026-05-06 real Codex-primary active-work smoke: injected
  `codex-resume` developer context produced marker `TL_CODEX_VISIBLE_REAL_20260506_C`
  in `item/agentMessage/delta`, confirming the rendered memory is model-visible
  as current work in a real Codex host.
- Documented the current Codex-primary setup flow. Global install manages only
  the Throughline Codex Stop hook / skill and preserves existing
  non-Throughline hooks; users can verify natural capture with `doctor --codex`,
  then summarize, render, or inject active-work memory through the `$throughline`
  skill or the explicit Codex CLI surfaces.
- Recorded the 2026-05-06 final Codex Stop hook smoke: after the absolute-path
  hook shape was installed, a newly started VSCode-origin Codex thread
  `019dfd62-9a9d-7211-bf91-89d8e3fc908e` naturally advanced the latest DB
  session to `codex:019dfd62-9a9d-7211-bf91-89d8e3fc908e` as reported by
  `doctor --codex`.
- Added and completed the Codex monitor implementation plan, documenting the
  host-aware state contract, Codex `rolloutPath`, verified `token_count`
  usage, and explicit estimate labeling.

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
