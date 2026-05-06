# AGENTS.md

このファイルは Codex など、Claude Code 以外のエージェントがこのリポジトリで作業する際の入口です。

**正本は [CLAUDE.md](CLAUDE.md) です。**

Throughline は Claude Code を主軸として育ってきたプロジェクトです。Codex 対応や rollback-based trimming を進める場合も、Claude 向けの hook、slash command、transcript contract、handoff behavior を Codex 用に置き換えてはいけません。

## 最初に読むもの

作業前に、最低限次を読むこと。

1. [CLAUDE.md](CLAUDE.md)
2. 変更対象の source / test
3. Codex 両対応や context trim に関わる作業なら:
   - [docs/THROUGHLINE_CODEX_DUAL_SUPPORT.md](docs/THROUGHLINE_CODEX_DUAL_SUPPORT.md)
   - [docs/throughline-rollback-context-trim-insight.md](docs/throughline-rollback-context-trim-insight.md)

`CLAUDE.md` と実装が食い違う場合は、まず実装を直接確認する。必要なら `CLAUDE.md` 側を更新する。

## Claude 正本を守る

- `.claude/`、Claude hooks、`/tl`、`/sc-detail`、Claude transcript parsing、Claude handoff / resume behavior は first-class のまま維持する。
- Codex 対応のために Claude-facing field、command name、hook shape、session / baton semantics を rename しない。
- 既存 Claude path を削除、劣化、Codex path への暗黙置換をしない。
- Codex 向け表現が必要な場合は、既存データを変更するのではなく adapter / projection を追加する。
- Claude contract に触れる変更では、先に現在挙動を固定する test / fixture を置く。

## Codex 作業方針

Codex は、このプロジェクトでは Claude の代替ではなく、追加の作業者または adapter 対象として扱う。

- agent-neutral core を増やす場合も、Claude adapter を既存互換のまま残す。
- Codex support は `throughline_handoff` context block や `codex-sidecar` integration として追加する。
- Codex-on-Codex の再帰委譲は、isolated worktree、structured result capture、明示的な review / critic role など別境界がある場合だけ許可する。
- `codex-sidecar` が未設定または diagnostics 失敗の環境を、成功扱いにしない。失敗は明示し、既存 Claude behavior を baseline として維持する。

## 2 つの計画の扱い

[docs/THROUGHLINE_CODEX_DUAL_SUPPORT.md](docs/THROUGHLINE_CODEX_DUAL_SUPPORT.md) と [docs/throughline-rollback-context-trim-insight.md](docs/throughline-rollback-context-trim-insight.md) は趣旨が異なるが、矛盾するものではない。

現時点の実装順の基本方針:

1. Claude contract を audit し、必要な test / fixture で固定する。
2. agent-neutral handoff object と Claude adapter 境界を明確にする。
3. Codex adapter / `throughline_handoff` projection を追加する。
4. rollback / inject primitive は spike として検証し、未検証のまま本線 UX に組み込まない。
5. rollback-based trim は、host primitive の実測結果に基づいて同一 session / thread の context management として設計する。

作業量や複雑さを理由に理想を下げない。ただし、未検証の host behavior を確定仕様として実装しない。

## 実装規律

- フォールバックや silent recovery で失敗を隠さない。互換モードを使う場合は条件と理由を明示する。
- 新しい Markdown を増やす前に、既存 docs に追記できないか確認する。
- 進捗を計画書と `CLAUDE.md` の該当箇所にそろえて残す。README はユーザー向け仕様なので、[docs/THROUGHLINE_CODEX_TRIM_IMPLEMENTATION_PLAN.md](docs/THROUGHLINE_CODEX_TRIM_IMPLEMENTATION_PLAN.md) の Phase 9 まで更新しない。
- source が正、docs は追従物。判断に迷ったらコードを読む。
- テストは `CLAUDE.md` の推奨コマンドを基準に、変更範囲に応じて追加する。
