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
- Install product hooks at `~/.grok/hooks/throughline.json`. Do not write factory.json.
- Grok hook `command` is absolute `node` + `bin/throughline.mjs` + subcommand. Do not write bare `throughline`.
- Keep Claude and Codex adapters unchanged. Do not mix `grok:` rows into Claude predecessor search.

## Consequences

- GF04 no-op is withdrawn.
- Restore/handoff for `grok:` sessions reuse existing DB + `handoff-context` after capture exists.
- Live Grok hook fire on each seat is a separate install+new-session acceptance.

## 現在地

Mac Desktop 新規session受入（2026-08-17 session `01a00b2f-ef4a-76e1-9f20-ce7e8d0b0ca0`）は失敗した。`throughline.json` はロード済みで `updates.jsonl` の `session_start` / `user_prompt_submit` が両方 `exit code 127: sh: throughline: command not found`。当時の POSIX install は bare `throughline` を書いており、Grok Desktop の GUI PATH では解けない。DB の `grok:` 行は 0 件。install を全platform絶対パスへ直し、このMacで `node bin/throughline.mjs install` 済み。席上の `~/.grok/hooks/throughline.json` は `/opt/homebrew/bin/node` + このrepoの `bin/throughline.mjs`。factory.json は未改変。このsessionの再受入は数えない。次は直したあとの新規sessionで `grok:` 行と L2 を実測する。
