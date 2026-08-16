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

## Consequences

- GF04 no-op is withdrawn.
- Restore/handoff for `grok:` sessions reuse existing DB + `handoff-context` after capture exists.
- Live Grok hook fire on each seat is a separate install+new-session acceptance.

## 現在地

Mac Desktop の restore 実機は閉じた（session `01a00b38-87ea-7670-8f7d-a9fe937263c5`）。`throughline handoff-context --session grok:01a00b38-87ea-7670-8f7d-a9fe937263c5 --json` は status ready、context 8730字。この会話の L2（受入依頼 / GO / 進めてくれ / もう一言だ）を含む。L1 skeletons と L3 details は 0 件のまま（Grok Stop は既存 Haiku L1 を回さない）。実装追加なし。hook `/tl` → 新規 session 注入は未了。auto path は `grok:` を前任から除外するので、Grok 同士の引き継ぎは `/tl` バトンが要る。`baton-write.log` に grok 行は無い。他席 install と Spotter は未了。Claude/Codex は触っていない。npm 未公開。
