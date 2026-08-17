# t5-memory-accept 証跡

担当: nagi  
plan: `grok-successor-launch`  
日付: 2026-08-17

## 何を測ったか

`throughline grok-continue --session grok:357ae0ac-3c94-488b-8ab6-fb8115599465` で立てた新席
`d29e113b-14d7-4c91-ab0d-6f83430862a8` の、最初のモデル応答が前文の記憶を使ったかを実測した。

成功条件は計画書どおり「宣言または L2 固有事実が出ること」。
`chat_history.jsonl` への後書きや hook stdout は成功に数えない。

## 試験内容

1. 同じ cwd（`/Users/kite/Developer/Throughline`）で `grok-continue` を実行し、stdout が `grok:d29e113b-14d7-4c91-ab0d-6f83430862a8` であること
2. 新席 `updates.jsonl` の初手 user 文に固定前文 `この発言は直前 Throughline 席の履歴を前提とする。` と handoff-context 本文が含まれること
3. 新席 `chat_history.jsonl` の最初の assistant 行が、前文が要求する宣言を含むこと
4. その宣言が `updates.jsonl` の `agent_message_chunk` にも出ること（モデル応答であり、hook stdout ではない）

## 試験結果

1. PASS。`grok-continue` exit 0、stdout `grok:d29e113b-14d7-4c91-ab0d-6f83430862a8`
2. PASS。`updates.jsonl` event 3 の `user_message_chunk` が前文3段を含む
3. PASS。最初の assistant 本文（102字）:

   「Throughline で前のセッションから 26 ターン分の記憶を引き継いだ状態で続けます」

   部屋の更新を読む。t4 以降の最終試験が届いているかを確認して、届いていれば監査、まだなら待ちを続ける。

4. PASS。同じ宣言が `agent_message_chunk` に出た

session ディレクトリ:
`~/.grok/sessions/%2FUsers%2Fkite%2FDeveloper%2FThroughline/d29e113b-14d7-4c91-ab0d-6f83430862a8/`
