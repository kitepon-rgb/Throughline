# ADR 0020: Windows CI release latency

- Status: Accepted
- Date: 2026-07-20
- Scope: Throughline v0.8.7 release gate

## Context

GitHub Actions run `29722650046` のWindows jobは約18分を要した。TAP上で突出した3テストは、
completed-turn receiptの256件境界を作るためproduction APIを257回呼び、mutationごとに
PowerShellでdirectory、SQLite lock、temporary、final storeのowner-only ACLを適用・検証していた。
境界計算の反復とWindows実ACLのintegration検証が結合され、短時間のmain pushでは9 job matrixが
重複起動していた。

read-only refuterによる敵対的検証ではP0はなく、次のP1を設計へ反映した。

- temporary ACL失敗時に旧storeを保持する回帰testが不足していた。
- refだけのconcurrency groupはmain pushと`workflow_dispatch`を相互cancelし得る。
- 5分SLOと同値のstep timeoutは共有runnerの一時遅延でflakeし得る。
- TAP durationの合計をjob wall timeとして扱ってはならない。

## Decision

1. 大量境界testは、production APIによる最初のprivate store作成後に正規schemaの256件fixtureをseedし、
   257件目だけをproduction APIで追加する。limit、history floor、project isolation、observer cursorの
   公開契約は変えない。
2. Windows ACLは三層で固定する。mock testで初回3回・継続4回のdistinct transitionを検査し、
   temporary ACL失敗時の旧store保持を失敗注入で検査し、Windows native testでdirectory、lock、
   final storeのowner-only ACLを外部helperから検査する。
3. completed-turn receipt本体は、apply scriptが同じPowerShell process内でread-back済みの新規
   directory／lock／temporaryを直後に再検証しない。ACL済みtemporaryのrename後はshapeだけを
   in-process検査し、final pathの実ACLはnative integration testで証明する。
4. CIはOS 3種 × Node `22.13.0`／`22.x`／`24.x`の9 matrixを維持する。unit test SLOは5分、
   目標3分、step timeoutは8分とする。
5. concurrency groupはworkflow、event、refで分離する。同じpush refまたは同じPR refの旧runだけを
   cancelし、`workflow_dispatch`とpush／PRは相互cancelしない。
6. 公開commitのCI番号・npm shasum・global install証拠はGitHub Releaseへ置く。証拠追記だけの
   Git commitと追加CIは作らない。

## Compatibility

- completed-turn receiptのschema、256件limit、pair identity、atomic rename、fail-closed ACLを維持する。
- Windows、macOS、LinuxおよびNode matrixを減らさない。
- Claude hooks、Codex adapter、Observer JSON-only CLI、DB migrationの挙動を変更しない。

## Rollback

公開前はfixture、本体最適化、workflow変更を同時にrevertする。公開後に戻す場合もACL安全網testを
先に外さず、旧実装へ戻したcandidateの9 matrixを通してから公開する。store migrationは不要である。

## Non-goals

- Windows testやACL検査のskip
- matrix縮小
- npm自動publish、credential保管
- release番号だけを根拠にした性能成功扱い
