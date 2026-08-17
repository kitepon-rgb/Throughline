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

Grok 1.0.4 バイナリの hook 出力型は `GateHookJson`（PreToolUse deny/updatedInput）と `StopHookJson`（block/additionalContext/stopReason）だけ。UserPromptSubmit / SessionStart / PostToolUse の stdout は observe。モデルへ文章を渡せる公式口は (1) PreToolUse deny の reason (2) Stop/SubagentStop の block reason / additionalContext / exit2 stderr。初回トークン前の prompt 注入口は無い。Stop 注入は初回返答のあと 2 周目に載る。`01a00cfe` の chat_history 書き込みは updates に乗らず実証済み。capture と handoff-context は生きている。

`/tl` 後の記憶再開は hook stdout や `chat_history.jsonl` 再注入では成立しない。後継経路は Throughline 所有の最小起動に固定する。正本は [plan_grok-successor-launch.md](../plan_grok-successor-launch.md)。

- CLI: `throughline grok-continue --session <id>`。`<id>` は `grok:` 接頭辞付き Throughline session id。`--from` は採用しない。
- 内部で `handoff-context --session <id> --json` を読む。ready でなければ spawn しない。
- 初手 user 文は次の 3 段だけ。`{context}` は handoff-context の `context` 文字列。JSON envelope は載せない。

  ```
  この発言は直前 Throughline 席の履歴を前提とする。

  {context}

  直前の作業の自然な続きとして応答すること。
  ```

- spawn は同じ cwd・共有 `GROK_HOME` の対話 `grok`。位置引数 `[PROMPT]` を使う。`--rules` / `--system-prompt-override` / `--agent` / 単発 `-p` は使わない。aiterm は使わない。
- Claude / Codex の `/tl` 契約は変えない。Grok `/tl` 成功後の副作用起動だけが配線対象。
- 一覧の正は `~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/` と `grok --resume`。Desktop Inactive 畳みは成功条件にしない。
