# WindowsのCodex引き継ぎ修正

## 原因と修正範囲

Windows実機で、通常の`codex-handoff-start`が対象projectの記録を発見できなかった。
次の3点を別々に確認した。

- Codexの`hooks/list`はThroughlineの記録用フック3件を`untrusted`と返した。
  自動記録の承認はCodexの利用者操作であり、Throughlineから承認状態を書き換えない。
- 導入済み0.10.3のparserは同じ実rolloutの本文を0件、0.10.14のparserは989件読めた。
  `response_item`対応は0.10.11で修正済みのため、共通parserを改造せず公式npmから更新した。
- npmのCodex起動ファイルがPATHにある通常のWindows環境で、app-serverの起動と
  schema生成が`spawnSync codex ENOENT`になった。Codex Desktopが実行ファイルのPATHを
  補う環境ではschema生成が成功し、同一端末でも実行入口によって差が出ていた。

`src/os/portable-spawn-sync.mjs`のOS境界に非同期起動を追加し、Windowsでは既存の
PowerShell起動ファイルの解決を使う。日本語の標準入力が既定の文字コードで文字化けする
再現も確認し、PowerShellの標準入出力をUTF-8へ揃えた。共通のapp-server本体と診断は
import先の変更だけとし、Mac/Linuxの起動は従来のNode子プロセスAPIへそのまま渡す。

## 確認

- OS境界の個別試験2件成功。npm型の起動ファイル、空白・記号・日本語の引数、
  日本語の標準入力、EOFを送る前の2回の要求・応答を実プロセスで確認した。
  この試験は製品のテスト用spawn置換を読み込まずに実行した。
- app-serverとschema診断の関連試験23件成功。
- 最終`npm test`は825件成功、7件は条件によりskip、失敗0件。
  初回の最終試験で見つかったCHANGELOGの比較リンク更新漏れは、文書試験5件で
  修正確認した後に全件を一度再実行した。
- 文書検査とnpm梱包内の相対リンク検査成功。梱包予定の253ファイルを確認した。
- 修正前に失敗した通常のWindows環境で、実Codexのschema生成がexit 0になった。
- 実行中の源タスクに対する読み取り後のresumeは`already has an active writer`で拒否された。
  元タスクのrollbackや注入は行わず、新規タスク引き継ぎの実機確認へ進んだ。
- 既存DBをtarで退避した後、更新済み製品の`codex-capture`で明示した元タスクを回収した。
  これは未承認期間の一度限りの回収であり、自動記録が復旧したとは扱わない。
- 修正版の`codex-handoff-start --execute --open-host desktop`は`started`を返し、
  `developer-item`注入とDesktopへのリンク起動を確認した。元タスクは保持される。

自動記録の継続受入には、Codex画面でThroughlineのフックを承認し、後続ターンの
保存を確認する必要がある。今回の修正は承認機構を追加・削除しない。

## 配布

修正候補は0.10.15。`npm whoami`が401を返すため、registryへの公開は未実施。
この端末への導入は、既定ブランチへ保存したcommitからnpmで梱包した修正版を使う。
registry公開完了と自動記録の継続成功は、今回の実測成果に含めない。
