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

## Terminal audit evidence

2026-08-08 に公開後の終端監査を再確認し、次を受け入れた。

- 公開commit `df215fcaeb6d09d13bfbf5389c6f7c98a995b25c` は現在の `origin/main` の祖先で、
  annotated tag `v0.8.7` は同commitへ解決する。
- GitHub Actions run `29726067549` は公開commitに対して9/9 greenである。Windows jobは
  2分46秒／2分53秒／2分59秒、unit test stepは2分14秒／2分26秒／2分38秒で、
  5分SLOと3分目標を満たした。
- GitHub Release `v0.8.7` はdraft／prereleaseではなく公開済みで、公開commit、CI run、
  Windows実測、npm shasumを保持する。
- npm registryの `throughline@0.8.7` はshasum
  `35a50f6878095d0881e75ebfb1da097a8da937c8`、integrity
  `sha512-7Z/Mz0FRT2bJaxOLl+M8AYlNp5AhmaouQYeiLQ5BKu94+iyo/p1l1vrOhlFHWMlNSv4a89mGYtEAzolPZGRKtA==`
  を返す。registryから再取得したtarballも同じSHA-1で、212 entries、package version `0.8.7`
  を確認した。
- 元のrelease sessionではregistry版global install、`throughline --version = 0.8.7`、
  managed hooks／skillの再install、migration、`doctor --codex` exit 0まで受け入れた。
  現在のglobal installは後続release `0.9.0`へ正当に更新済みのため、監査目的のdowngradeは行わない。

以上により、製品受入は2026-07-20時点で完了しており、遅延していたLattice terminal-auditの
記録を証拠付きで閉じてよいと裁定する。
