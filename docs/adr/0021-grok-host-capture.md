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

## Consequences

- GF04 no-op is withdrawn.
- Restore/handoff for `grok:` sessions reuse existing DB + `handoff-context` after capture exists.
- Live Grok hook fire on each seat is a separate install+new-session acceptance.

## 現在地

live `/tl`（session `01a00b38`）は hook success だったがバトンは書かれなかった。Grok の prompt は `<user_query>/tl</user_query>` + skill 本文で、裸 `/tl` 判定に当たらない。判定を user_query 剥がしにし、hook prompt が空なら `chat_history` の最終 user を見る。`/new` は Grok の `/clear` alias として baton 対象。`source=new` を auto path にはしない。live 再 `/tl` と `/new` 後の注入は未測。Claude/Codex の裸コマンド判定は維持。npm 未公開。他席と Spotter は未了。
