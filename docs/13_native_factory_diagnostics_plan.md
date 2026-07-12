# Wave 4: Native Factory Diagnostics

## 目的

`throughline factory-diagnostics --json` を追加し、Throughline の native
factory 接続に必要な read-only readiness を、安定した機械可読 JSON として返す。
この診断は capture / restore / handoff を実行せず、DB・state・hook 設定・rollout・
session の本文、秘密、絶対パス、例外詳細を出力しない。

## 契約

- 診断 schema は versioned とし、CLI version、diagnostic schema、overall、database
  schema/migration、hook、capture / restore / handoff の代表 read-only readiness を返す。
- 判定値は `ready` / `not_ready` / `not_applicable` / `unverified`。正常に未設定な
  代表入力は `not_applicable`、観測不能・判定不能は `unverified` とし、pass に丸めない。
- `overall` は `ready` を、必須の applicable check がすべて `ready` の場合だけ返す。
  `unverified` は成功に含めない。
- 既存の `doctor` / `status` の人間向け stdout 契約は変更しない。既存 helper の
  read-only projection だけを利用し、runtime error store / telemetry は追加しない。
- CLIは`--json`をちょうど一つ必須とする。exit 0は有効snapshot、exit 1は固定文言の
  internal diagnostic failure、exit 2は固定文言のusage errorを表す。
- DBは`PRAGMA user_version`だけでgreenにせず、正規table/column/index shapeをread-onlyで
  検証する。handoff memoryは一致確認済みproject/threadだけを数える。
- restore capabilityとlive smoke evidenceを分離する。未実行smokeは`unverified`だが、
  capability readinessを恒常的に失敗扱いにはしない。
- Codex hookはcanonical shapeを検査するが、trust実火は機械検証不能なので`unverified`に
  留める。Claude connectorはこの単位では未検査として明示`unverified`にする。

## 実施 TODO

- [x] 既存の doctor / status、Codex capture、restore、handoff、state schema、hook
  入口、および関連するテストを実読する。
- [x] 変更前のベースラインとして `npm test` を green で取得する。
- [x] privacy / schema / characterization fixture を先に追加し、本文・秘密・絶対パスを
  含めない JSON 契約を固定する。
- [x] read-only factory diagnostics の projection と CLI entrypoint を実装する。
- [x] version、diagnostic schema、overall、state schema、hook、capture / restore /
  handoff readiness を段階別に返す。
- [x] help / README の実装済み CLI 仕様を追記する。
- [x] 対象テスト、`npm test`、`git diff --check` を通し、差分を再読して完了確認する。

## 完了条件

- JSON は stdout に一つだけ出力され、read-only fixture で DB・state・設定を作成・更新しない。
- 代表 capture / restore / handoff の未設定と不明を区別し、unverified を ready にしない。
- 出力・エラーには session / prompt 本文、秘密、絶対パス、raw state / log が含まれない。
