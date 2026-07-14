# ADR 0003: Bind Observer cursors to host-completed pair chains

Date: 2026-07-15

## Status

Accepted

## Context

Observer must follow the latest completed Claude or Codex parent for one canonical project without treating an in-flight response, file mtime, DB update, or synthetic continuation as completion. Existing Codex parsing intentionally preserves assistant-only continuations for memory rendering, including rows that have no later `task_complete`. Claude completion is now represented by the project-owned receipts accepted in ADR 0002.

The Observer-facing cursor is a local continuation token, not an authorization credential. It must be opaque to consumers, contain no raw path or body, and be checked against the current completed source chain before any body is returned.

## Decision

Throughline will normalize both hosts into a completed-pair chain with these rules:

- Claude: read the private receipt file selected by canonical project SHA-256. Each retained receipt contributes one completed pair anchor. `history_floor` is part of verification; a cursor older than the retained floor requires resync.
- Codex: a parsed turn is completed only when its own `task_complete` event was observed. The parser will retain that event timestamp as `completedAt`. Open turns, pending messages, and synthetic assistant-only continuations have `completedAt = null` and never advance the Observer chain.
- Each chain entry binds host, hashed thread/session identity, origin identity hash, normalized user hash, normalized assistant hash, and host completion timestamp. Raw project paths and bodies are excluded from cursors.
- A cursor binds schema version, canonical project digest, host, hashed selected thread identity, retained chain length/floor, and a rolling SHA-256 prefix digest. Throughline validates all fields against the current source chain. Encoding is an implementation detail and consumers must only store and return the bounded token.
- A same-thread append is valid only when the prior chain is an exact prefix. A shorter chain, changed prior pair, cursor below `history_floor`, unknown version, or project mismatch returns `resync_required`.
- A different selected thread returns `thread_switched`; a different selected host returns `host_switched`. A new thread does not become current until it has a completed pair.
- Parent candidates are ordered by host-provided completion timestamp. Ties within one host are resolved deterministically by hashed thread identity and source identity. A top timestamp tie across Claude and Codex is `ambiguous_parent`; Throughline does not guess from mtime.
- DB bodies remain a read-only projection. A selected source pair whose project/session/pair hashes do not match DB returns `projection_pending` and does not advance the accepted cursor.

## Consequences

- Existing memory rendering may continue to include synthetic continuations; the Observer adapter filters by explicit `completedAt` rather than changing that behavior.
- Rollback and retention loss are visible state transitions, not silent truncation.
- Empty projects can produce an empty baseline cursor and later detect the first completed pair.
- Cursor integrity comes from revalidation against product-owned receipts or rollout events. The token is not presented as a security boundary or cross-user capability.
- Page tokens must additionally bind project, after-cursor, through-cursor, and offset so new completions cannot enter an existing page series.
