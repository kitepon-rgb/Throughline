# Read-only handoff context

## 目的

通常 handoff が使う `buildBudgetedResumeContext` の出力を、DB 所有権を変えずにローカルプログラムが
取得できる read-only CLI として公開する。最初の consumer は AIterm の portable fork だが、I/F は
特定 consumer や vendor に依存させない。

実行 ToDo、依存、状態、完了証拠の正本は Lattice plan `readonly-handoff-context` とする。

## 完了

2026-08-04に`throughline@0.9.0`としてnpm、tag、GitHub Release、global installまで公開した。
focused契約testと全回帰は729 pass／1 skip／0 fail。AIterm v0.23.0の代表cross-vendor smokeでは
Codex source memoryをClaudeへ注入し、前後でsource session、`sessions.merged_into`、L1/L2/L3 row所属が
完全一致することを確認した。公開後の現行ドキュメント全域監査は、Latticeの終端ToDoを再openして
README、作業者入口、配布Codex skill、docs索引、計画、CHANGELOGへ同期した。変更Markdownの
相対リンク監査とCLI help／handoff-contextのfocused test 5/5を通過した。

## 契約

- `throughline handoff-context --session <id> --json` は session を明示必須とする。
- 既存 DB を `DatabaseSync(..., { readOnly: true })` で開き、作成・migration・書込みをしない。
- `buildBudgetedResumeContext(db, { sessionId, isInheritance: true })` をそのまま使う。
- 成功 JSON は schema、status、sessionId、context だけを返す。renderer 統計は公開しない。
- 引数不正、DB open 失敗、context 不在は非 0 終了とする。

## 非目標

- baton、pending handoff、merge、backfill、通常 SessionStart / UserPromptSubmit の変更。
- Observer projection、Codex 専用 renderer、latest session 推測、project/cwd 照合。
- DB schema 全面診断、hash、cursor、暗号化、daemon、network I/O、retry、cache。
- budget や `excludeOriginId` を CLI option として公開すること。

## 受入条件

- CLI の context が同じ DB に対する既存 budgeted renderer の出力と完全一致する。
- 実行前後で `sessions.merged_into` と L1/L2/L3 の `session_id` が変わらない。
- DB 不在時に DB や親ディレクトリを作らない。
- focused test と全回帰が成功し、公開 package と global install から新 command を実行できる。
