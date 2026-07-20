# ADR 0019: 製品所有DB migrationの公開受入

## 状態

Accepted — 2026-07-20

## 親裁定

`throughline migrate --json` の実装と公開版 `0.8.6` を、Throughlineの製品所有DB migration入口として
受け入れる。`factory-diagnostics`のread-only契約、DB不在時に作成しない契約、future schema拒否を維持する。

## 実装・回帰証拠

- 設計: [ADR 0018](0018-product-owned-database-migration.md)
- 実装commit: `6fd9554`
- clean republish commit: `4f9908d`
- focused test: DB schema、factory diagnostics、migrate CLIの16件すべてgreen
- full test: 実装受入時の `npm test` green
- GitHub CI: run `29724249940`、Node 22.13.0／22.x／24.x × macOS／Ubuntu／Windowsの9/9 green
- clean pack: 208 files、`src/cli/migrate.mjs`を収録し、並行作業の
  `docs/15_windows_ci_release_latency_plan.md`を含まないことを機械確認

## 公開証拠

- npm `latest`: `throughline@0.8.6`
- registry shasum: `b4a9ccda9b69715d51c37408d696a210103ee47a`
- tag / GitHub Release: `v0.8.6`
- `0.8.5`はrelease dry-run後に別セッションの未コミット文書1件がworktreeへ書かれ、tarballへ混入した。
  runtime codeは同一だったがpackage scopeを不合格とし、tag / GitHub Releaseを作らずnpm deprecateした。
  `0.8.6`は受理済みcommitから作った隔離clean worktreeで再pack・再公開した。

## 4 host受入

| host | version | migration | DB schema | Throughline factory check |
|---|---:|---|---|---|
| mac-kite | 0.8.6 | `already_current` | 9 / 9 | ready |
| main-server | 0.8.6 | `already_current` | 9 / 9 | ready |
| FOX WSL2 | 0.8.6 | `already_current` | 9 / 9 | ready |
| FOX Windows native | 0.8.6 | `already_current` | 9 / 9 | ready |

FOX Windows nativeは旧command形のCodex hook 3本を検出したため、`throughline install`でThroughline管理分だけを
現行形へ正規化し、再投影後に`database_schema=pass`、`codex_hooks=pass`を確認した。UI trustは人手領域として
変更していない。

dotagentsのfactory reporter全体は、Caveat native diagnostics、Codex routing、toolchain ledger、
main-server stale ingestという既存の別checkによりredのままである。Throughline migration／schema／hooksとは
分離し、他製品の修理を本受入へ混入させない。Lattice checkは全hostでpassし、Lattice本体は変更していない。

## H操作の記録とrollback

目的は更新直後のDB migrationを製品所有入口で確定し、全hostへ配布すること。影響はnpm `latest`、Git tag / Release、
4hostのglobal Throughline、FOX WindowsのThroughline管理hook/skillである。rollbackはnpm `latest`とglobal installを
0.8.4へ戻し、hookは`throughline uninstall`または保存済み設定backupから復元する。DB schemaの自動downgradeはせず、
必要時は更新前DB backupから復元する。オーナーの本戦役H承認に基づき実行した。
