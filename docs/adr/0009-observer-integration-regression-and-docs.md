# ADR 0009: Observer統合の関連回帰と公開文書を受け入れる

日付: 2026-07-15

## Status

Accepted

## Context

Observer向けcompleted-turn feedは、追加したread/wait境界だけでなく、既存のClaude Stop hook、Codex
capture、auditor-context、token monitorとの互換を維持する必要がある。また、実装済みの公開CLI契約を
README、AI向け正典、docs overview、CHANGELOGへ同期し、DB直接監視をfallbackとして案内してはならない。

## Decision

1. 次の関連gateをO1統合回帰として受け入れる。

   ```text
   node --import ./src/test-env.mjs --test \
     src/hook-entrypoints.test.mjs src/codex-capture.test.mjs \
     src/auditor-context.test.mjs src/cli/auditor-context.test.mjs \
     src/cli/codex-hook.test.mjs src/token-monitor.test.mjs
   ```

   結果は130件成功、失敗・skip・cancel・todo各0、実行時間807.298msだった。
2. commit `fb558d7`のREADME、CLAUDE.md、`docs/00_overview.md`、CHANGELOG同期を受け入れる。
3. 文書は`observer-read`／`observer-wait`をJSON-only CLIとして説明し、opaque cursor、read/wait状態、
   `projection_pending`、最大3600秒wait、Claude receiptとCodex `task_complete`のcompleted境界を記録する。
4. ThroughlineはMCP serverを所有せず、ObserverへDB、WAL、rolloutの直接監視fallbackを案内しない。
5. 未公開、Phase full regression、pack gate、独立監査は完了扱いせず、次のO1 gateへ残す。

## Consequences

- O1の関連回帰と文書同期TODOを完了できる。
- full `npm test`、`npm pack --dry-run --json`、独立監査はPhase完了時に一度だけ実行する。
- このADRはTask `observer-feed-doc-sync`のfinalization Decisionとして使い、追記可能なplanは使わない。
