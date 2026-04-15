# Throughline

> Claude Code hooks plugin for `/clear`-safe persistent memory, with accurate
> multi-session token monitoring built on Anthropic's real usage values.

Throughline splits every conversation turn into **three memory layers** and stores
them in SQLite. On the next prompt, it reinjects just enough context to keep Claude
on task — even across `/clear`, across new sessions, and across **chains of
`/clear`** spanning multiple days.

It also ships an independent multi-session **token monitor** that reads real
Anthropic API usage from the transcript JSONL (no `length / 4` heuristics, no
tokenizer libraries required).

---

## Quick Start

```bash
npm install -g throughline
throughline install
```

That's it. `install` registers Throughline's hooks in `~/.claude/settings.json`
(user scope), so every Claude Code project on your machine picks it up
automatically. No per-project wiring required.

Start any Claude Code session and your turns will begin flowing into
`~/.throughline/throughline.db` in the background.

---

## Three-layer memory model

| Layer | Name       | Where it lives       | Content                                           | Cost         |
| ----- | ---------- | -------------------- | ------------------------------------------------- | ------------ |
| **L1** | Skeleton  | injected every turn  | one-line summary of intent and outcome            | ~10 tok/turn |
| **L2** | Judgment  | injected every turn  | structured decisions, constraints, open issues    | ~50 tok/turn |
| **L3** | Detail    | SQLite only          | raw tool I/O (Bash, Write, Edit, Read, Grep, ...) | ~2k+/turn    |

On every `UserPromptSubmit`, Throughline rebuilds L1 + L2 from the current session
and injects them as plain text into the next prompt. L3 stays in SQLite and can be
retrieved on demand if the detail is ever needed again.

---

## `/clear`-safe with memory rebonding

When you run `/clear`, the conversation transcript is discarded, but the SQLite
database is untouched. On the next session start:

1. `SessionStart` hook fires with a new `session_id`
2. Throughline finds the previous session in the same project
3. It **rebonds** all `skeletons` / `judgments` / `details` rows from the previous
   session into the new session (via `UPDATE session_id = ?`)
4. A handover banner is injected:
   `## Throughline: セッション記憶（N ターン引き継ぎ）`
5. From there, normal `UserPromptSubmit` injection takes over

Each row keeps its **origin session id**, so memories accumulate through chains of
`/clear` rather than being lost or overwritten:

```
S1 (4 turns) -- /clear --> S2 (merges S1, adds 3 turns) -- /clear --> S3 (merges S2, adds 5 turns)
                           origin=S1×4                                origin=S1×4, S2×3, S3×5
```

No time-window heuristic, no PID guessing, no ancestor walking. Just a
deterministic UPDATE inside a SQLite transaction.

---

## Multi-session token monitor

Run:

```bash
throughline monitor            # all active sessions in the current project
throughline monitor --all      # every project, every session
throughline monitor --session <id-prefix>
```

Example output (real values from a running 1M-context Opus session):

```
[Throughline] 1 セッション
▶ smartcompact       2ed5039c  ████░░░░░░░░░░░░░░░░  205.1k /  21%  残 794.9k  claude-opus-4-6
```

- **Token counts are accurate.** Read straight from the latest `message.usage`
  field in the session transcript JSONL, which is what Anthropic's API actually
  reported (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`).
  No `length / 4` approximation.
- **1M-context detection** is automatic. If observed usage exceeds 200k, the monitor
  promotes the session to a 1M context window retroactively.
- **Multi-session view.** Each Claude Code session writes its own state file
  (`~/.throughline/state/<session_id>.json`). The monitor scans the directory
  every second and displays one row per live session, sorted by last activity.
  The most recent one is highlighted with `▶`.
- **Stale hiding.** Sessions that haven't been touched in 15 minutes drop out of
  the default view; files older than 24 hours are deleted entirely. This is the
  only time threshold in the system and is used solely for display hygiene — no
  memory decisions are made from it.
- **Parallel project safety.** State is per-session, so running two Claude Code
  windows in different projects no longer causes the monitor to flicker between
  them.

### VS Code auto-start

For contributors working on Throughline itself, a `.vscode/tasks.json` in this
repo launches `throughline monitor` automatically in a dedicated terminal when
you open the folder. If you want the same for your own project, drop this into
your `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Throughline Monitor",
      "type": "shell",
      "command": "throughline monitor",
      "isBackground": true,
      "presentation": {
        "reveal": "always",
        "panel": "dedicated",
        "group": "throughline",
        "close": false,
        "echo": false,
        "focus": false,
        "clear": true
      },
      "runOptions": { "runOn": "folderOpen" },
      "problemMatcher": []
    }
  ]
}
```

VS Code will ask once whether you want to allow automatic tasks. Click **Allow**.

---

## Commands

| Command                             | What it does                                                 |
| ----------------------------------- | ------------------------------------------------------------ |
| `throughline install`             | Register hooks in `~/.claude/settings.json` (user scope)     |
| `throughline install --project`   | Register hooks in `.claude/settings.json` for this repo only |
| `throughline uninstall`           | Remove Throughline hooks from the settings file             |
| `throughline monitor [--all] [--session <id>]` | Run the multi-session token monitor               |
| `throughline doctor`              | Check Node version, hook registration, DB writability, PATH |
| `throughline status`              | Print DB statistics (sessions, turns, judgments counts)      |
| `throughline --version`           | Print the installed version                                  |

Hook subcommands (invoked by Claude Code, not by humans):
`capture-tool`, `process-turn`, `inject-context`, `session-start`.

---

## Requirements

- **Node.js >= 22.5** (for the built-in `node:sqlite` module — no native build
  required, no `npm install` of SQLite bindings)
- **Claude Code** with hooks support (`SessionStart`, `UserPromptSubmit`,
  `PostToolUse`, `Stop`)
- Works on **Windows, macOS, Linux**

Throughline has **zero runtime dependencies**. The published tarball is just
plain `.mjs` files.

---

## Data layout

```
~/.throughline/
├── throughline.db          SQLite database (WAL mode)
└── state/
    └── <session_id>.json     Per-session activity state for the monitor
```

Schema (v3):

- `sessions` — one row per `session_id`, with `project_path` and `merged_into`
- `skeletons` — L1 one-liners, keyed by `(session_id, origin_session_id, turn, role)`
- `judgments` — L2 structured items, deduplicated by `content_hash`
- `details` — L3 tool I/O, with token count
- `injection_log` — audit trail of every injection event

All tables carry an `origin_session_id` so rebonded rows keep their lineage after
a `/clear` chain.

---

## Design principle: no fallback code

Throughline deliberately refuses to swallow unexpected errors.
Silent `try { … } catch { /* ignore */ }` blocks hide bugs; instead, hooks throw
and exit with a non-zero status so Claude Code surfaces the failure in `stderr`.

Specifically:

- JSON parse failures → `throw`, not `continue`
- Missing required fields → `throw new Error(...)`, not `exit(0)`
- DB transactions → explicit `BEGIN IMMEDIATE` / `ROLLBACK` / re-throw
- Hook entry points wrap `main()` with a single `.catch` that writes `stderr` and
  exits with code 1

The only tolerated silent paths are:
- JSONL per-line parse tolerance (tail partial writes are part of the format spec)
- State-file corruption recovery (files are idempotently regenerated next turn)

See [`docs/PUBLIC_RELEASE_PLAN.md §0`](docs/PUBLIC_RELEASE_PLAN.md) for the full
rule.

---

## Troubleshooting

**Monitor says `待機中 — アクティブなセッションがありません`**
No session has touched its state file in the last 15 minutes. Send a message in
Claude Code and the monitor should pick it up within 1 second. If it still does
not, run `throughline doctor`.

**`throughline install` wrote to the wrong settings file**
By default, Throughline installs to `~/.claude/settings.json` (user scope, applies
to all projects). Use `--project` to scope it to the current directory's
`.claude/settings.json` instead.

**Hooks never fire**
Run `throughline doctor` — it checks Node version, hook registration, DB
writability, and PATH resolution. If the binary is not on PATH, reinstall with
`npm install -g throughline`.

**`node:sqlite` warning on startup**
Node.js prints `ExperimentalWarning: SQLite is an experimental feature` on stderr.
This is cosmetic — the module is stable enough for production and is used
unchanged here.

**Database got corrupted / want a clean slate**
Delete `~/.throughline/throughline.db`. A fresh database with the current
schema is created on the next hook fire.

---

## Development

```bash
git clone https://github.com/kitepon-rgb/Throughline.git
cd Throughline
node install.mjs                      # Register hooks for this repo only
node src/token-monitor.mjs            # Run the monitor directly (no global install)
```

The `.vscode/tasks.json` in this repo auto-launches the monitor when you open the
folder in VS Code.

---

## Design docs

- [`docs/CONCEPT.md`](docs/CONCEPT.md) — background and original design rationale
- [`docs/PUBLIC_RELEASE_PLAN.md`](docs/PUBLIC_RELEASE_PLAN.md) — the release plan
  this README is tracking, with full per-section history including design
  decisions that were rolled back

---

## License

MIT — see [LICENSE](LICENSE).
