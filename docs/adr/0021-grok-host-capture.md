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
- Grok UserPromptSubmit stdout is observe-only. Writing into `chat_history.jsonl` does not enter the live model prompt. Live conversation is `updates.jsonl`. Claude still uses stdout additionalContext.

## Consequences

- GF04 no-op is withdrawn.
- Restore/handoff for `grok:` sessions reuse existing DB + `handoff-context` after capture exists.
- Live Grok hook fire on each seat is a separate install+new-session acceptance.

## 現在地

新 session `01a00cfe` は baton 消費・merge・`chat_history` L5 への `system_reminder` 注入まで成功した。その文は `updates.jsonl` / `prompt_context.json` / 初回 assistant のどれにも無い。Grok のライブ文脈は chat_history を再読しない。UserPromptSubmit でモデルに記憶を足す公式面は無い。capture と `handoff-context` restore は生きている。同じ窓への hook 自動注入は host 非対応。他席と Spotter は未了。
