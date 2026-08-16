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

Grok hostはpayloadの`transcriptPath`を使わず導出先`chat_history.jsonl`だけを読む。根拠は session `01a00b38` のStopが`updates.jsonl`を読んで`groups:0`、同一readerは`chat_history.jsonl`ならturns 16 / groups 3。focused test（`hook-envelope` / `hook-entrypoints` / `transcript-reader-grok`）23件pass。Claude/Codex adapterは未変更。このMacのhookはrepoの`bin/throughline.mjs`なので再install不要。live L2はまだ再測していない。次はこのsessionの次Stopで`backfill.log`が`chat_history.jsonl`になりbodiesにuser/assistantが載ること。npm未公開・restore/handoff実機・Spotter着手はしていない。
