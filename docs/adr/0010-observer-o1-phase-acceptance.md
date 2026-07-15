# ADR 0010: Observer O1 Phaseを監査修正込みで受け入れる

日付: 2026-07-15

## Status

Accepted

## Context

Observer向けcompleted-turn feedのPhase O1は、Claude receiptとCodex `task_complete`から
host-neutralなcompleted chainを構築し、rollback、prefix差替え、pagination、deadline、cancel、
privacyの境界を維持する。Phase完了候補でfull regressionと独立監査を一度ずつ実施したところ、
監査は二つの実欠陥を発見し、監査時点の製品判定をFAILEDとした。

1. Claude Stopが複数の過去turnを一括backfillした時、最後のpairしかreceiptへ公開しない。
2. Codex project resolverがPOSIX pathまで小文字化し、caseだけ異なるprojectを誤照合し得る。

## Decision

1. 独立監査の製品判定FAILEDをControl revision 67でrejectとして保持する。監査の指摘を
   成功扱いへ書き換えず、同じTODOへの独立監査も反復しない。
2. P1はcommit `02a809f`で、backfillが返す全logical turn numberを時系列でClaude receiptへ
   publishする。receipt storeのsame-pair冪等性により、DBだけ回収済みだった過去pairも穴埋めする。
3. P2はcommit `88fafaf`で、POSIX pathのcaseを保持し、Windows drive pathだけを従来どおり
   case-insensitiveに扱う。
4. P1/P2修正後のfocused gateを受け入れる。

   ```text
   node --import ./src/test-env.mjs --test \
     src/turn-backfill.test.mjs src/hook-entrypoints.test.mjs \
     src/codex-thread-index.test.mjs
   ```

   結果は28件成功、失敗・skip・cancel・todo各0、実行時間693.58925msだった。
5. Phase完了候補のfull `npm test`は監査前HEAD `c5d6f2d`で一度実施し、661件中660件成功、
   失敗0、Windows限定1件skip、cancel・todo各0、実行時間32983.729625msだった。
   監査後の変更範囲は上記focused gateで全て再検証した。fullを現HEADで再実行したとは扱わない。
6. 修正後HEADの`npm pack --dry-run --json`は`throughline@0.6.3`、entryCount 190、shasum
   `0d27e31c334f1f1941c27383e7f2a61f20c2e370`で成功した。`git diff --check`も成功した。
7. Phase O1の実装・関連回帰・文書同期・full/pack・独立監査とその二指摘の修正を完了とする。
   publish、registry、実端末展開は別Waveであり、このDecisionには含めない。

## Consequences

- Claude receiptとCodex `task_complete`のcompleted chainは、複数turn回収とPOSIX case境界を含めて
  Observerのread/wait契約へ渡せる。
- full regressionを細かな修正ごとに反復せず、監査後deltaをfocused gateで検証した証拠が残る。
- このADRをTask `observer-feed-phase-audit`、Phase gate、Control finalizationの不変Decision証拠に使う。
