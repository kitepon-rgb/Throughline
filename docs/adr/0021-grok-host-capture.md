# ADR 0021: Treat Grok as a first-class Throughline host

Date: 2026-08-17

## Status

Accepted

## Context

Throughline v0.9.1 no-op'd Grok camelCase hook envelopes (GF04) because Grok was not a factory parent host. Wave 5 made Grok a peer parent. The 2026-08-16 factory ruling requires Throughline Grok capture / restore / handoff.

Grok stores turns in `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/chat_history.jsonl`, not Claude JSONL.

## Decision

- Detect the camelCase envelope (`sessionId` + `hookEventName`, no `session_id`) as host=grok.
- Normalize it to the existing snake_case hook contract and prefix ids with `grok:`.
- Read L2 from Grok `chat_history.jsonl`. Do not invent a Claude-shaped transcript.
- Grok host ignores payload `transcriptPath`. Live Stop sends `updates.jsonl`, which has no user/assistant rows.
- Install product hooks at `~/.grok/hooks/throughline.json`. Do not write factory.json.
- Grok hook `command` is absolute `node` + `bin/throughline.mjs` + subcommand. Do not write bare `throughline`.
- Keep Claude and Codex adapters unchanged. Do not mix `grok:` rows into Claude predecessor search.
- Grok `/tl` / `/clear` / `/new` detection reads the inner `<user_query>`. If the hook `prompt` is empty, fall back to the last user row in `chat_history.jsonl`. Do not treat `source=new` as Claude `source=clear` auto-handoff.
- Grok UserPromptSubmit stdout is observe-only. Handoff inject writes a `synthetic_reason=system_reminder` user row into `chat_history.jsonl` immediately before the latest `<user_query>`. A custom synthetic_reason is stored and dropped from the model prompt. Claude still uses stdout.

## Consequences

- GF04 no-op is withdrawn.
- Restore/handoff for `grok:` sessions reuse existing DB + `handoff-context` after capture exists.
- Live Grok hook fire on each seat is a separate install+new-session acceptance.

## 現在地

新 session `01a00cf9` は baton 消費・merge・`chat_history` への注入行まで成功した。行の `synthetic_reason` が独自値 `throughline_handoff` だったため Grok がモデル文脈から外した。ネイティブと同じ `system_reminder` に直し、冪等は `data-throughline-handoff` で見る。Claude stdout は維持。live 再測は未了。
