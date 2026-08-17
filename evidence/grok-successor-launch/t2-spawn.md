# t2-spawn 証跡

担当: nagi  
plan: `grok-successor-launch`  
日付: 2026-08-17

## 何を作ったか

`throughline grok-continue --session <id>` を追加した。

- `handoff-context` と同じ `--session` で継承文脈を読む
- 失敗・空・grok 不在・非 darwin では spawn しない
- 初手は契約どおりの 3 段。`grok --session-id <uuid> <PROMPT>`
- `--rules` / aiterm / tmux は使わない
- hook から呼べるよう、macOS Terminal を `osascript` で前面に出す
- 新しい Throughline session id `grok:<uuid>` を標準出力へ出す

変更: `src/cli/grok-continue.mjs`、`src/cli/grok-continue.test.mjs`、`bin/throughline.mjs`、`CLAUDE.md`

## 試験内容

focused: `node --import ./src/test-env.mjs --test src/cli/grok-continue.test.mjs src/cli/help.test.mjs`

確認した受入:

- handoff-context 失敗 / throw / grok 不在では spawn しない
- 初手文面に前文・context・続き依頼がこの順で入る
- grok argv と launch script に `--rules` が無い
- 起動は Terminal / osascript で、aiterm が無い
- bin が `grok-continue` を dispatch し help に載る

## 試験結果

16/16 pass、0 fail。
