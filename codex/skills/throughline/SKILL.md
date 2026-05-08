---
name: throughline
description: Use when the user asks to use Throughline from Codex, continue or restore Throughline memory, run Codex trim/rewind/rollback, inject remembered context, summarize a captured Codex session, or check whether the Throughline Codex Stop hook captured the current session. Hide long Throughline command details behind this workflow.
---

# Throughline

Use this skill to operate Throughline from Codex without making the user type long
commands.

If the user invokes `$throughline` by itself, treat that as a request to inspect
the current Codex context and prepare a refresh plan. Codex rollback / inject is
enabled again after controlled rollback model-visible smokes failed to reproduce
rollback marker resurrection.

## Core Rule

Do not ask the user for a Codex thread id when the current environment can
provide it. Prefer the current `CODEX_THREAD_ID` / `THROUGHLINE_CODEX_THREAD_ID`
identity and verify it with `throughline doctor --codex`.

Do not manually capture payloads before checking natural Stop hook capture.
If natural capture looks wrong, inspect `doctor --codex`, the latest rollout,
and hook logs first.

## Common Requests

### Bare "$throughline" / "use Throughline"

Run:

```bash
throughline doctor --codex
throughline trim --dry-run --host codex --all --json
throughline codex-handoff-start --session codex:<current-thread-id> --json
throughline trim --preflight --host codex --all --json
```

This is the safe Codex context-refresh inspection flow. `--all` previews a
rollback-based reset of the model-visible thread. `codex-handoff-start` is an
optional fresh-thread continuation surface: it validates the handoff, shows the
model-smoke dry-run boundary, and can render the prompt with `--print-prompt`
without mutating the current thread. Report the preflight result, handoff-start
status, and context reduction estimate from the dry-run. Do not claim the
refresh happened unless `trim --execute` or auto-refresh actually ran.

The injected memory must preserve the original `/tl` memory contract:

- older turns: L1 summaries
- recent work: L2 full bodies for the latest 20 turns
- L3: detail references only; L3 bodies / tool payloads are not injected

If the dry-run reports no captured turns or no injectable memory, say that
clearly.

### "Throughline status" / "doctor"

Run:

```bash
throughline doctor --codex
```

Report whether:

- Codex hooks feature is enabled
- Codex Stop hook is registered
- VSCode monitor task is registered, and whether `Developer: Reload Window` is
  needed to make the folder-open monitor appear
- current Codex thread and latest DB session match

### "resume" / "memory" / "continue from Throughline"

First run `throughline doctor --codex`.

If the current thread and latest DB session match, render memory with:

```bash
throughline codex-resume --session codex:<current-thread-id>
```

If the user gave a current-work memo, pipe it with `--memo-stdin`.

If the user wants to continue in a fresh Codex thread instead of mutating the
current thread, use:

```bash
throughline codex-handoff-start --session codex:<current-thread-id> --print-prompt
```

If the user gave a current-work memo, pipe it with `--memo-stdin`. This is
read-only and does not mutate the current thread.

### "summarize"

Run:

```bash
throughline codex-summarize --session codex:<current-thread-id> --json
```

Codex-primary summarization uses the Codex CLI backend. Do not claim it fell
back to Claude Haiku.

### "trim" / "rewind" / "rollback" / "context cleanup"

Default to the same inspection flow as bare `$throughline` when the user
asks to trim, rewind, rollback, clean up context, or use Throughline memory.

Preview:

```bash
throughline trim --dry-run --host codex
```

Safe new-thread continuation:

```bash
throughline codex-handoff-start --session codex:<current-thread-id> --json
```

Report the context reduction estimate from the dry-run when present:

- rollback candidate estimated tokens
- injected memory estimated tokens
- net estimated token reduction and percentage

The estimate is `chars / 4` from rollout text, not an exact host tokenizer
measurement. If rollback candidate turns are `0`, say that this session has no
current trim savings yet under the active keep-recent setting.

Guard check:

```bash
throughline trim --preflight --host codex
```

Execute path:

```bash
throughline trim --execute --host codex --all
```

Run this only when the user explicitly wants the current thread trimmed. It sends
rollback + Throughline DB memory injection after the app-server guard checks.

## User-Facing Explanation

Explain the behavior simply:

- normal Codex turn end: Stop hook captures DB memory and writes monitor state
- `$throughline` / context refresh: doctor, dry-run, preflight, and optional
  execute; execute mutates the current Codex thread
- Stop hook auto-refresh attempts rollback / inject when verified usage reaches
  90%; estimate usage does not trigger mutation
- dry-run reports estimated savings when there are rollback candidate turns, but
  exact host-visible token reduction is not yet measured with the host tokenizer
