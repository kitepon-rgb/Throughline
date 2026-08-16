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

Mac Desktop capture受入は閉じた（2026-08-17 session `01a00b38-87ea-7670-8f7d-a9fe937263c5`、このDesktop窓。前sessionの見た目は数えない）。Throughline origin/mainは`a964e0a`。`updates.jsonl`の`global/throughline:session_start` / `user_prompt_submit` / `stop`はsuccess。最新stopは96ms。`backfill.log`は`chat_history.jsonl`で`groups:4` `inserted_turns:4`（それ以前の同一sessionは`updates.jsonl`で`groups:0`）。DBに`grok:01a00b38-87ea-7670-8f7d-a9fe937263c5`行とL2 user/assistant 4往復（8行）がある。成功条件（この新規sessionの`grok:`行とL2）は達した。Claude/Codexは触っていない。npm未公開。restore/handoff実機と他席install、Spotterは未了。
