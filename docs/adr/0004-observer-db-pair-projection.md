# ADR 0004: Observer本文はcompleted chainとDB pairの全件照合後だけ返す

**状態:** Accepted  
**日付:** 2026-07-15  
**対象:** Throughline Observer completed-turn feed

## 文脈

Observerのcursor正本は、Claude Stop receiptまたはCodex `task_complete`で閉じたcompleted pair
chainである。一方、Throughline DBの`bodies`にはStop receipt publish前のpair、receipt publishに
失敗したpair、Codex capture後にまだ完了していないpairが存在し得る。DBの末尾N件や
`sessions.updated_at`をそのまま読むと、cursorに存在しない本文を完了済みとして渡してしまう。

既存`auditor-context`はread-only DB、schema version、project境界、origin session、user／assistant
hashのfreshness照合と本文上限を所有する。Observer用に別のDB解釈を作らず、この低層契約を
共有する必要がある。

## 決定

1. `auditor-context`の低層に、completed pair chainの期待値を順序どおり照合するread-only helperを置く。
2. 入力する期待値は`origin_sha256`、`user_sha256`、`assistant_sha256`だけとし、各値はSHA-256の
   厳格なlowercase hexとする。DBの`origin_session_id`はhelper内部でhash化し、外へ返さない。
3. helperは指定`session_id`のDB bodiesを既存と同じ規則でuser／assistant pairへ組み立て、期待chainの
   各要素を同じ順序で一対一に照合する。同じhash組が繰り返されても、一つのDB pairを二回使わない。
4. session不存在、DB schema不一致、project不一致、期待pairの欠落またはhash不一致は本文を部分返却
   しない。Observer projectionはこれらを`projection_pending`またはhard failureへ明示写像し、cursorを
   進めない。
5. 本文を返すのは、要求された期待pairが全件一致した場合だけとする。各turnへ元本文のcontent digestと
   `truncated`を付ける。本文上限でturn identityを黙ってdropせず、本文が空まで切れた場合も
   `truncated: true`のturn recordを残す。
6. 選択candidateはDB queryに必要なraw target session identityをmodule内部だけで保持してよい。
   public result、cursor、page token、error、logへraw session ID、origin ID、project path、本文を複製しない。
7. Claudeのsession mergeはreceiptの`target_session_id`をDB `session_id`として使い、各pairは
   `origin_session_id`のhashで照合する。Codexは`codex:<thread_id>`をDB `session_id`として使い、同じ
   pair hash規則を使う。
8. DB schemaとwrite pathは変更しない。helperは既存DBをread-onlyで開き、transactionやhandleを
   呼出し後に保持しない。

## 状態写像

| DB/helper結果 | Observer read |
|---|---|
| 全期待pair一致 | 本文projectionを返せる |
| DB/session/pairがまだ無い | `projection_pending`、turns空、cursor据置 |
| schema不一致 | 固定code付きhard failure |
| project不一致 | 固定code付きhard failure |
| I/O/query失敗 | 固定code付きhard failure |

`projection_pending`は成功したdeltaではない。Observerはretryできるが、through cursorを保存済みcursorへ
昇格させてはならない。

## 受入fixture

- completed chainが1件、DBが0件なら`projection_pending`で本文ゼロ。
- DBに進行中またはreceipt未成立pairが余分にあっても、期待chain外の本文を返さない。
- Claude merge targetと複数originを、origin hashとbody hashで順序付きに照合する。
- Codexのturn ordinalがrollbackで変わっても、origin／pair hashが一致すれば本文を解決する。
- userまたはassistant hashが一文字でも違えば部分本文を返さない。
- project不一致、schema不一致、DB不存在を区別する。
- 本文上限で全turn recordを保持し、digestと`truncated`を返す。

## 非目標

- page token、snapshot/delta pagination、`throughCursor`固定
- `observer-read`／`observer-wait` CLI dispatch
- DB migration、receipt retention変更、Observer repo変更

## rollback

新しいread-only helper、Observer projection接続、testsだけを独立revertする。既存auditor-context公開API、
DB schema、Claude／Codex captureのwrite pathは変更しない。
