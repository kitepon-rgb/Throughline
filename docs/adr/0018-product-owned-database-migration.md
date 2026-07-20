# ADR 0018: product-owned database migration

- Status: Accepted
- Date: 2026-07-20
- Scope: dotagents `factory-master/fm-0645`

## Context

`agents-update` はregistry packageを更新した直後にfactory reporterを実行する。Throughlineの
`factory-diagnostics` は意図的にread-onlyであり、旧schema DBを検出してもmigrationせず
`not_ready`を返す。一方、現行のmigration入口は通常のwrite CLIがDBを開く副作用に埋もれている。
このためschema更新後の初回updateは、利用者が別CLIを手で一度実行しない限り失敗する。

## Decision

1. Throughlineは `throughline migrate --json` を製品所有の正規入口として提供する。
2. 対象は既存のdefault DBだけとする。DBが存在しない場合は作成せず`not_applicable`、現行schemaは
   `already_current`、旧schemaは既存のproduction migrationを実行して`migrated`を返す。
3. 対応版より新しいschema、migration失敗、migration後のversion不一致は非0で明示する。
   silent fallback、DB削除、空DBへの置換は行わない。
4. JSONはversioned schema、before/after/supported schema version、statusを持つ。秘密、DB内容、絶対pathは
   出力しない。
5. dotagentsの`agents-update`はThroughline package更新後、factory reporterより前にこの入口を自動実行する。
   利用者に別の手動migrationを要求しない。migration失敗はupdate失敗として残し、factory gateで隠さない。
6. v8 fixtureからv9への移行、現行schemaの冪等性、DB不在時の非作成、future schema拒否、strict CLI引数、
   updaterの実行順と失敗伝播をfocused testで固定する。

## Compatibility

- Claude/Codex hooks、handoff、baton、recall、通常の`getDb()`自動migrationは変更しない。
- `factory-diagnostics`はread-onlyのまま維持し、診断にmutationを混ぜない。
- migration commandは任意pathや任意SQLを受け取らず、Throughline所有DBだけを扱う。

## Rollback

公開前は本commitをrevertする。公開後は旧packageへ戻せるが、DB schema downgradeは行わない。
schema更新前のDBへ戻す必要がある場合は、hostごとに更新前backupを復元して対応版packageを使う。

## Non-goals

- Lattice本体・Lattice repoの変更
- factory reporter側でのThroughline DB mutation
- schema downgrade、DB repair、破損DBの自動再生成
