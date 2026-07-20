# ADR 0017: Codex handoff の open host は現在の UI surface から明示する

- Status: accepted（2026-07-20実装・v0.8.4公開）
- 関連: [Codex First Roadmap](../05_codex_first_roadmap.md)、
  [Codex Trim Rollback修正計画](../06_codex_trim_rollback_fix_plan.md)

## 問題

Codex Desktopから `$throughline` を使っても、コマンド実行shellが以前のVS CodeやTerminalから
継承した永続PTYである場合、`--open-host auto` は現在のUIではなく古い環境変数を見てしまう。
新しいthread自体は正しく作られても、表示先だけがVS CodeやCLIへ逸れる事故になっていた。

## 決定

- `$throughline` skillは、AIが現在動いているCodex UI surfaceをDesktop／VS Code／CLIから選び、
  `codex-handoff-start --execute --open-host <surface>` として明示する。
- shell／永続PTYの継承環境は、skillのsurface判定根拠にしない。
- `auto`は直接CLIからsurfaceが本当に不明な場合の互換経路として残す。
- `codex-handoff-start`は既存consumer向けの`openHost`を維持し、requested hostとresolved hostを
  JSON／textの両方へ追加して、host解決を観測可能にする。
- Claude-facing hooks、`/tl`、baton、transcript、resume契約は変更しない。

## 棄却した案

1. **Desktop判定環境変数の優先順位だけを上げる**: 古いPTYに残った値を「現在のUI」と誤認する
   根本問題が残るため棄却した。
2. **`auto`を削除する**: 既存CLI consumerとの互換を不要に壊すため棄却した。
3. **既存`openHost` fieldをrenameする**: machine-readable consumerを壊すため、追加fieldで拡張した。

## 受入証拠

- 公開commit: `5b840b69688713ba29f4d39f8520953bae846ea7`
- GitHub Actions: run `29721583754`、Linux／macOS／Windows × Node 22.13.0／22.x／24.xの9/9成功
- npm: `throughline@0.8.4`、`latest = 0.8.4`
- npm shasum: `1f2c39a22e45f3e02e8739ee5fd6ceefc6a71034`
- GitHub Release: `v0.8.4`
- registry由来global install: `/opt/homebrew/lib/node_modules/throughline`はsymlinkでないcopy、
  `throughline --version`は`0.8.4`
- `throughline install`後の`~/.codex/skills/throughline/SKILL.md`はrepoと公開packageの双方に
  byte-for-byte一致し、`doctor --codex`はexit 0

`doctor --codex`はローカルの`.vscode/tasks.json`に古い絶対パスがあることも警告したが、
診断上は「次のVS Code hook eventで修復」とされる既存ローカル状態であり、本releaseの
host選択契約や公開packageの受入失敗ではない。

## 帰結

- Codex UIとcommand実行shellの由来が異なっても、handoffの表示先は現在のUIへ固定される。
- requested／resolved hostの差を出力から追跡でき、将来のhost追加でもsilent fallbackを避けられる。
- Claude primaryの既存surfaceとCodexのcurrent-thread診断pathは影響を受けない。
