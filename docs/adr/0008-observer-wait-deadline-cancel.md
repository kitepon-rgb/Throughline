# ADR 0008: observer-waitはmonotonic deadlineの最終再確認と明示cancelを持つ

日付: 2026-07-15

## Context

Observerは完了turnが無い間、最大一時間Throughlineを待つ。DB／WAL／mtimeは完了証拠ではなく、
Claude receiptまたはCodex `task_complete`から再構成したcompleted cursorだけがchangedを決める。
deadline到達時に再確認せずtimeoutすると境界直前の完了を取りこぼし、cancel時にtimerやsignal listenerを
残すと次のwaitへ副作用が漏れる。wall clockの変更で一時間を過不足させてもならない。

この契約はControlのDecision証拠に使うため、追記可能な計画書ではなく不変ADRとして置く。

## Decision

1. Libraryは`waitForObserverTurnChange`を公開し、`projectPath`、必須`afterCursor`、
   `timeoutSeconds`（既定3600、1以上3600以下）、`AbortSignal`と既存host read optionsを受ける。
   test用のclock／sleep／resolver injectionは非公開または明示的なdependency引数としてよいが、公開CLI
   optionにはしない。
2. 呼出直後に一度completed-only cursorを再計算する。after cursorが無効なら`resync_required`、
   cross-host tieなら`ambiguous_parent`、cursorが変化済みなら待たず`changed`を返す。
3. 変化が無い時だけ短いintervalで再計算する。deadlineはmonotonic clockで固定し、wall clockの進退を
   duration判定へ使わない。DB transaction、file handle、host固有index snapshotをsleep中に保持しない。
4. 各wake後はtimeout判定より先にcompleted cursorを再計算する。deadline以上でも最後の一回がchanged、
   `resync_required`、`ambiguous_parent`ならその状態を返し、最後までunchangedの時だけ`timeout`を返す。
   deadline後に追加のpoll cycleは開始しない。
5. wait wireは`throughline.observer_wait.v1`とし、次のshapeだけを返す。raw project path、本文、session／
   thread／origin ID、host index pathを含めない。

   ```json
   {
     "schema": "throughline.observer_wait.v1",
     "status": "changed",
     "afterCursor": "tlc1....",
     "throughCursor": "tlc1...."
   }
   ```

   | status | throughCursor |
   |---|---|
   | `changed` | 呼出seriesの新しいcompleted cursor |
   | `timeout` | 入力`afterCursor`と同値 |
   | `resync_required` | `null` |
   | `ambiguous_parent` | `null` |

6. AbortSignalが呼出前または待機中にabortされたら成功wireを返さず、固定codeを持つcancel errorで終了する。
   signalと完了が同じwakeで競合した時は、abort観測後に新しい成功pollを開始しない。pending timerを解除し、
   Libraryは呼出後にlistener／handleを保持しない。
7. 公開CLIは次とし、`--project`、`--after-cursor`、`--json`を必須にする。未知／重複option、値欠落、
   範囲外timeoutを拒否する。`--timeout-seconds`既定は3600である。

   ```text
   throughline observer-wait --project <absolute-existing-directory>
     --after-cursor <opaque> [--timeout-seconds <1..3600>] --json
   ```

8. 4種の既知状態はstdout単一行JSON、stderr空、exit 0とする。hard failureはstdout空、stderr単一行の
   固定error JSON、exit 1とし、例外本文やpath／cursor／hash／raw identityを転記しない。

   | 条件 | code | message |
   |---|---|---|
   | CLI構文／timeout形式 | `E_OBSERVER_WAIT_ARGS` | `invalid observer-wait arguments` |
   | projectのhard input拒否 | `E_OBSERVER_WAIT_INPUT` | `observer wait input is invalid` |
   | signal／parent disconnect | `E_OBSERVER_WAIT_CANCELLED` | `observer wait was cancelled` |
   | その他の内部失敗 | `E_OBSERVER_WAIT_INTERNAL` | `observer wait failed` |

9. CLIは`SIGINT`、`SIGTERM`、Node IPCの`disconnect`を一つのAbortControllerへ写す。通常の子processが
   IPC無しで親だけ終了する場合も一時間孤児化しないよう、起動時`ppid`を保存し、poll interval以下の
   周期で`process.ppid`変化または`process.kill(parentPid, 0)`の`ESRCH`を検出してabortする。`EPERM`は
   親不在の証拠にしない。終了時にsignal listenerと親watch timerを必ず外す。stdout／stderrのpipe断は
   成功扱いにせず、`EPIPE`を握りつぶして別経路へfallbackしない。
10. cursorのversion、project、prefix、rollback不一致はLibrary既定どおり`resync_required`でexit 0とする。
    waitはDB本文freshnessを待たず、`changed`後の`observer-read`が`projection_pending`を裁定する。

## Consequences

- 呼出前に完了済みなら即時changed、待機中なら次poll、deadline境界なら最終再確認で回収できる。
- timeout、resync、曖昧親、cancelを混同せず、Observerは保存cursorを安全に据え置ける。
- 一時間waitでもtransactionやtimer leakを残さず、read側のDB freshness責務を重複しない。
- OSがSIGKILLした場合のcleanupや親死活監視daemonは非目標であり、通常signal／IPC／pipe契約を越えて
  成功を偽装しない。
