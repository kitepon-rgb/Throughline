# Windows CI・リリース待ち時間改修計画

## 目的

ThroughlineのWindows CIがLinux／macOSの約1分に対して16〜18分かかり、定型releaseを
実用不能な長さへ押し上げている。Windows互換性matrixとowner-only ACL契約を維持したまま、
unit testを5分以内（目標3分以内）へ短縮し、release前の同一candidateに対するCIを1回へ
集約する。

## 現状の実測

GitHub Actions run `29722650046`（Windows Node 22.13.0）のTAP計測では、次の3テストが
突出していた。TAP durationはwall timeとして加算せず、job全体の実測約18分をbaselineとする。

| テスト | `duration_ms` |
|---|---:|
| observer feed: Claude history floor, host/thread switch, cross-host tie, and opaque cursor | 568,093 ms |
| completed turn receipt: bounded store drops only oldest receipts | 559,807 ms |
| completed turn receipt: noisy project cannot evict another project anchor | 436,267 ms |

3テストはいずれも256件境界を作るため公開APIを257回呼び、その各mutationでWindows
PowerShellを複数回起動してdirectory／lock／temporary／final storeのACLを検証している。
境界計算の反復とACL実機検証が結合されていることが主因で、runner一般の遅さではない。

また現行workflowはmainへのpushごとに9 matrixを新規起動し、同じbranchの旧runをcancelしない。
短時間の段階commitでWindows 18分runが重複する。

## 決定

1. completed-turn receiptの大量境界テストは、正規schemaの境界直前storeをfixtureとして用意し、
   最後の1 mutationだけ公開APIで実行する。limit超過、history floor、project分離、cursor判定の
   受入条件は変更しない。
2. Windows owner-only ACLは専用integration testでdirectory、SQLite lock、final storeを
   `windows-acl-test-helper`から外部検証する。大量境界テストからPowerShell反復を除いても、
   production ACL契約の実機coverageを失わない。
3. CIのunit test stepへ`timeout-minutes: 8`を設定する。SLOは5分、目標3分としrunner遅延と分離する。
4. workflowへevent／ref単位の`concurrency`を設定し、新しいcommitが来た時は同一event／refの
   古いrunだけをcancelする。手動runとpush／PRは相互cancelしない。
5. OS 3種 × Node `22.13.0`／`22.x`／`24.x`の9 matrixは維持する。互換範囲を速度対策のために
   縮小しない。
6. `0.8.7`の最終candidateへ実装・version・CHANGELOG・README・正本文書をまとめ、push後CIを
   1回だけrelease gateとして使う。公開後のSHA／CI番号はGitHub Releaseを正本とし、証拠追記だけの
   追加commit／追加CIを作らない。

## 非目標

- Windows ACLの適用・read-back検証、atomic rename、失敗時の旧store保持を弱めない。
- Windows testをskipしない。matrixのOS／Node versionを減らさない。
- completed-turn receiptの256件limit、history floor、cursor、project分離契約を変えない。
- Claude hooks、Codex adapter、DB migration、handoff契約を変更しない。
- release自動publishやcredential保管をworkflowへ追加しない。

## 既知の罠

- fixtureを直接書くだけでは公開APIの境界mutationを検証できない。必ずlimit直前から最後の1件を
  `writeCompletedTurnReceipt`で追加する。
- Windowsでfixtureを書き換える時も既存owner-only ACLを保持し、専用ACL testはproduction APIが
  作った実pathを外部helperで検査する。
- `concurrency.cancel-in-progress`は別branch／別PRをcancelしないref単位にする。
- test timeoutはunit test stepへ8分で置き、5分SLOにrunner一時遅延の余白を持たせる。
- 進行中の旧CIを新しいcandidateの成功証拠として流用しない。

## 受入条件

- [ ] 3つの大量境界テストが公開契約を維持したままPowerShell反復を行わない。
- [ ] Windows専用ACL testがdirectory／lock／storeのowner-only ACLを外部検証する。
- [ ] focused testとfull `npm test`がgreen。
- [ ] CI定義にunit test 8分上限とevent／ref単位concurrencyがある。
- [ ] 最終GitHub Actionsで9/9 green、Windows各jobのunit testが5分以内（目標3分以内）。
- [ ] `npm pack --dry-run --json`で公開物を確認する。
- [ ] npm `throughline@0.8.7`、tag／GitHub Release、registry由来global install、
  `throughline --version = 0.8.7`、配置skill／hooks／doctorを確認する。

## 敵対的検証の反映

read-only refuterはP0なし、P1を4件報告した。TAP durationをwall timeとして加算しないこと、
temporary ACL失敗時の旧store保持testを加えること、concurrencyへ`event_name`を含めること、
5分SLOとtimeoutを分離することを採用した。fixture seedと本体の重複ACL検証削減は、最後の公開API
mutation、native final-path ACL test、atomic failure testを同時に置く条件で妥当と裁定した。

## 工程

工程状態と完了証拠の正本はLattice storeとし、この文書は目的、判断、非目標、受入条件を所有する。

1. ベースライン計測と原因同定
2. 敵対的検証と設計裁定
3. 安全網とfixture分離
4. workflow・文書統合
5. push後CI、npm公開、global install
