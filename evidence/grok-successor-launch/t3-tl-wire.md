# t3-tl-wire 証跡

担当: nagi  
plan: `grok-successor-launch`  
日付: 2026-08-17

## 何を作ったか

`prompt-submit` の Grok `/tl` 成功（baton 書き込み）のあと、`grok-continue --session <id>` を副作用で呼ぶ。

- Claude `/tl` と Grok `/clear` では呼ばない
- baton 書きは維持する
- context が無い isolated fixture では grok-continue は spawn せず終了コード 1 を返し、hook は stderr に理由を書いて exit 0 のまま baton を残す

変更: `src/prompt-submit.mjs`、`src/prompt-submit.test.mjs`、`src/hook-entrypoints.test.mjs`、`CLAUDE.md`

## 試験内容

`node --import ./src/test-env.mjs --test src/prompt-submit.test.mjs src/hook-entrypoints.test.mjs src/cli/grok-continue.test.mjs`

- `shouldLaunchGrokContinue` は Grok `/tl` だけ true
- `launchGrokContinueAfterTl` は `--session` を渡す
- Grok `/tl` subprocess は baton を書き、stderr に `grok-continue exited` がある
- Claude `/tl` subprocess は baton を書き、`grok-continue` を呼ばない

## 試験結果

55/55 pass、0 fail。
