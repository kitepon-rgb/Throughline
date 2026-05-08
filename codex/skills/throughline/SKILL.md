---
name: throughline
description: Use when the user asks to use Throughline from Codex, continue or restore Throughline memory, run Codex trim/rewind/rollback, inject remembered context, summarize a captured Codex session, or check whether the Throughline Codex Stop hook captured the current session. Hide long Throughline command details behind this workflow.
---

# Throughline

Use this skill to operate Throughline from Codex without making the user type long
commands.

If the user invokes `$throughline` by itself, treat that as a request to run the
scripted current-thread refresh now. The normal path is not an AI planning
exercise: it rolls back the current Codex thread and injects Throughline DB
memory using the original `/tl` contract.

## Core Rule

Do not ask the user for a Codex thread id when the current environment can
provide it. Prefer the current `CODEX_THREAD_ID` / `THROUGHLINE_CODEX_THREAD_ID`
identity.

For bare `$throughline`, do not run doctor / dry-run / handoff / preflight first
and do not ask for confirmation. Execute the script command directly. If it
fails, report the error plainly instead of silently falling back to another
memory source or a fresh-thread handoff.

## Common Requests

### Bare "$throughline" / "use Throughline"

Run:

```bash
throughline trim --execute --host codex --all --json
```

This is the scripted Codex context-refresh flow. It mutates the current Codex
thread by sending rollback + Throughline DB memory injection. Report only the
execution status, whether rollback / inject were sent, whether durable evidence
was observed, and the selected memory session.

The injected memory must preserve the original `/tl` memory contract:

- recent work: L2 full bodies for the latest 20 turns
- older turns: L1 summaries
- L3: detail references only; L3 bodies / tool payloads are not injected

If there are no captured turns or no injectable Throughline DB memory, say that
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

Default to the same scripted execute flow as bare `$throughline` when the user
asks to trim, rewind, rollback, clean up context, or use Throughline memory.

Execute:

```bash
throughline trim --execute --host codex --all --json
```

Report only the essential outcome. Do not introduce fresh-thread handoff,
restore-safety analysis, host primitive audit, or dry-run planning unless the
user explicitly asks for those diagnostics.

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

This is the same command used by bare `$throughline`.

## User-Facing Explanation

Explain the behavior simply:

- normal Codex turn end: Stop hook captures DB memory and writes monitor state
- `$throughline` / context refresh: one script command mutates the current Codex
  thread by rollback + memory inject
- injected memory is L2 latest 20 full bodies + older L1 summaries + L3
  references only
- diagnostics such as doctor, dry-run, preflight, fresh-thread handoff, restore
  safety, and host primitive audit are optional tools, not the normal
  `$throughline` path
