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

Mac Desktop 新規session受入（2026-08-17 session `01a00b38-87ea-7670-8f7d-a9fe937263c5`、このDesktop窓。前session `01a00b2f` の見た目は数えない）。Throughline origin/mainは`4b6bf72`、dotagents origin/mainは`f8889fd`。`~/.grok/hooks/throughline.json`のcommandは`/opt/homebrew/bin/node` + このrepoの`bin/throughline.mjs` + subcommand。factory.jsonは未改変。このsessionの`updates.jsonl`で`global/throughline:session_start`はsuccess 37ms、`user_prompt_submit`はsuccess 34ms。127 / command not found は無い。`events.jsonl`にthroughline痕跡は無い。`throughline status`と`~/.throughline/throughline.db`に`grok:01a00b38-87ea-7670-8f7d-a9fe937263c5`行はある（project_path `/Users/kite/Developer/dotagents`）。bodiesのL2 user/assistantは0件。当turn未完了のため`process-turn`（Stop）のhook_executionはまだ無い。実装上L2はStopが`chat_history.jsonl`からbackfillする。Claude/Codexの既存sessionとsettingsは触っていない。npm未公開・restore/handoff実機・Spotter着手はしていない。成功条件（この新規sessionの`grok:`行とL2）はL2未達。次はこのsessionの次turnでStop / L2を実測する。
