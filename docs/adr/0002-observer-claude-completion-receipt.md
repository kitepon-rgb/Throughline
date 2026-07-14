# ADR 0002: Use Throughline-owned Claude Stop receipts for completed turns

Date: 2026-07-15

## Status

Accepted

## Context

Observer needs a durable, completed-only feed for both Claude and Codex parents. Claude Code 2.1.207 was characterized on macOS with an authenticated Max account using Haiku 4.5 and plan permissions.

- Headless `claude -p --output-format stream-json --verbose` returned `type=result`, `subtype=success`, `stop_reason=end_turn`, and a stable `session_id`.
- `--resume <session_id>` reused the same session and emitted `SessionStart:resume`.
- Background mode rejects `--print`; the supported form is `claude --bg '<task>'`.
- A background session returned job handle `6fdf0944`, moved from `busy/working` to `idle/done`, remained discoverable through `claude agents --json --all`, exposed output through `claude logs`, and accepted `claude stop`.
- The background UI showed Stop hooks running after the final assistant message. A final transcript message or process exit alone is not a durable completed-turn boundary.
- Claude `/rewind` creates a forked conversation rather than destructively rolling back the current conversation. Throughline must not add a false same-session Claude rollback surface.

The observed identifiers above are smoke evidence only. Production cursors must not embed local paths, account identifiers, prompt text, or raw session logs.

## Decision

For Claude, Throughline's own Stop hook will write a bounded, private, atomic completion receipt after the completed user/assistant pair has been captured successfully. The receipt will bind at least:

- schema version and host `claude`;
- canonical project identity digest;
- Claude session identity;
- completed user/assistant content digests;
- a host-provided completion timestamp and monotonic receipt sequence.

The Observer feed will derive its Claude completed chain from these receipts and verify the corresponding read-only DB projection before returning bodies. Transcript mtime, session index order, DB `updated_at`, final assistant presence, and headless process exit are not completion proof.

Codex continues to use rollout `task_complete`. Claude headless Worker completion uses the first valid stream-json `type=result` event; OS process exit is cleanup state, not logical completion. Background Observer supervision uses the Claude job handle and `agents/logs/stop` lifecycle, not a guessed PID-only contract.

## Consequences

- Existing Claude hooks, transcript parsing, DB schema, `/tl`, and baton behavior remain first-class and compatible.
- Stop receipt write failure is explicit and cannot advance the completed cursor.
- A captured receipt with a stale or missing DB projection produces `projection_pending`; it does not expose stale bodies.
- `/rewind` and `/clear` continue through the existing new-session baton and SessionStart path. No Claude equivalent of Codex `thread/rollback + thread/inject_items` is invented.
- Long-running Claude subprocess callers treat stream-json `type=result` as logical completion and separately clean up or recover the process/session handle.
