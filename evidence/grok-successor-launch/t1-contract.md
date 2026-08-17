# t1-contract 証跡

担当: nagi  
plan: `grok-successor-launch`  
日付: 2026-08-17

## 何を作ったか

実装はしていない。起動核の契約を次の2ファイルへ固定した。

- `docs/plan_grok-successor-launch.md`
- `docs/adr/0021-grok-host-capture.md` の現在地

固定した内容:

- CLI: `throughline grok-continue --session <id>`（`--from` 不採用）
- 内部は `handoff-context --session <id> --json`。ready でなければ spawn しない
- 初手文面3段:
  1. `この発言は直前 Throughline 席の履歴を前提とする。`
  2. `{context}`（handoff-context の `context` 文字列。JSON envelope は載せない）
  3. `直前の作業の自然な続きとして応答すること。`
- 非目標: aiterm / `--rules` / `--system-prompt-override` / `--agent` / 単発 `-p` / Claude・Codex `/tl` 変更 / hook stdout や chat_history 再注入による Desktop 修復 / npm publish・Spotter
- focused 受入と実機受入（t4/t5）を計画書へ分離して書いた

## 試験内容

文書固定の focused 照合。実装 test は対象外。

1. 両ファイルに CLI 名 `throughline grok-continue --session <id>` がある
2. 計画書に「候補:」が残っていない
3. 両ファイルに前文と続き依頼の固定文がある
4. 計画書に aiterm 禁止・`--rules` 禁止・Claude/Codex `/tl` 非変更・handoff-context 失敗時非 spawn がある
5. ADR 現在地に `--from` 不採用がある
6. 今回の変更に `src/` `bin/` が無い

## 試験結果

上記 1〜6 はすべて PASS（2026-08-17、canonical worktree）。失敗 0。
