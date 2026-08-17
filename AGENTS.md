# AGENTS.md

このファイルは Codex など、Claude Code 以外のエージェントがこのリポジトリで作業する際の入口です。

**正本は [CLAUDE.md](CLAUDE.md) です。**

Throughline は Claude Code を主軸として育ってきたプロジェクトです。Codex 対応や rollback-based trimming を進める場合も、Claude 向けの hook、slash command、transcript contract、handoff behavior を Codex 用に置き換えてはいけません。

## 最初に読むもの

作業前に、最低限次を読むこと。

1. [CLAUDE.md](CLAUDE.md)
2. 変更対象の source / test
3. Codex 両対応や context trim に関わる作業なら:
   - [docs/05_codex_first_roadmap.md](docs/05_codex_first_roadmap.md)
   - [docs/08_codex_dual_support.md](docs/08_codex_dual_support.md)
   - [docs/09_rollback_context_trim_insight.md](docs/09_rollback_context_trim_insight.md)
4. DB記憶を別プロセスへ渡す作業なら:
   - [docs/16_readonly_handoff_context_plan.md](docs/16_readonly_handoff_context_plan.md)
5. Grok host / `/tl` 後継なら:
   - [docs/adr/0021-grok-host-capture.md](docs/adr/0021-grok-host-capture.md)
   - [docs/plan_grok-successor-launch.md](docs/plan_grok-successor-launch.md)

`CLAUDE.md` と実装が食い違う場合は、まず実装を直接確認する。必要なら `CLAUDE.md` 側を更新する。

Grok は first-class host である。capture は `chat_history.jsonl`、hook は
`~/.grok/hooks/throughline.json` の絶対パス。Grok `/tl` の記憶再開は
`throughline grok-continue --session grok:<id>` だけとする。stdout 再注入、
aiterm、`--rules`、`--from` を現行契約に戻さない。

## Claude 正本を守る

- `.claude/`、Claude hooks、`/tl`、`/sc-detail`、Claude transcript parsing、Claude handoff / resume behavior は first-class のまま維持する。
- Codex 対応のために Claude-facing field、command name、hook shape、session / baton semantics を rename しない。
- 既存 Claude path を削除、劣化、Codex path への暗黙置換をしない。
- Codex 向け表現が必要な場合は、既存データを変更するのではなく adapter / projection を追加する。
- Claude contract に触れる変更では、先に現在挙動を固定する test / fixture を置く。

## Codex 作業方針

Codex は、このプロジェクトでは Claude の代替ではなく、追加の作業者または adapter 対象として扱う。

- agent-neutral core を増やす場合も、Claude adapter を既存互換のまま残す。
- Codex support は `throughline_handoff` context block、Codex primary entrypoint、Codex CLI backend、`codex-sidecar` integration として追加する。
- Codex-on-Codex の再帰委譲は、isolated worktree、structured result capture、明示的な review / critic role など別境界がある場合だけ許可する。
- `codex-sidecar` が未設定または diagnostics 失敗の環境を、成功扱いにしない。失敗は明示し、既存 Claude behavior を baseline として維持する。

## Read-only handoff context

`throughline handoff-context --session <id> --json` は、同一端末内のlauncherが既存sessionの
継承文脈を取得するためのread-only境界である。通常handoffのようにbatonを消費したり、memory rowの
`session_id`や`sessions.merged_into`を変更したりしない。consumerはSQLiteを直接読まず、このCLIの
versioned JSONだけを使う。Observer向け`observer-read`／`observer-wait`はcompleted-turn projectionで
目的が異なるため、portable forkの代替にしない。

## 2 つの計画の扱い

[docs/08_codex_dual_support.md](docs/08_codex_dual_support.md) と [docs/09_rollback_context_trim_insight.md](docs/09_rollback_context_trim_insight.md) は趣旨が異なるが、矛盾するものではない。

現時点の実装順は [docs/05_codex_first_roadmap.md](docs/05_codex_first_roadmap.md) と
[docs/06_codex_trim_rollback_fix_plan.md](docs/06_codex_trim_rollback_fix_plan.md) を正とする。

2026-05-07 correction: 2026-05-06 時点では 1 と 2 を完了扱いしていたが、
VS Code restart / reconnect 後に rollback 済み user prompt が復活した incident 後、
2 は restart-safe 完了ではない。Codex primary の capture / summarize / resume は
完了扱いできるが、Codex trim execute / auto-refresh は durable restore safety が
未証明である。

1. Throughline を Codex primary で使えるようにする。Codex primary の L2 -> L1 backend は Codex CLI を本線にする。
2. Codex で Claude Rewind 相当の context trim を完成させる。
3. そのあと Claude 側の `/rewind` UX / 自動化 surface を詰める。

新セッションで迷った場合は、まず [docs/05_codex_first_roadmap.md](docs/05_codex_first_roadmap.md) の「新セッション引き継ぎ」と
[docs/06_codex_trim_rollback_fix_plan.md](docs/06_codex_trim_rollback_fix_plan.md) を読む。
Codex 側をやり直さず、現行状態から継続する。2026-05-08 時点では Codex
current-thread trim は `trim --execute --host codex --all` で guarded rollback +
Throughline DB developer-memory inject を送れる。必須条件は Codex thread identity、
Throughline DB injectable memory であり、rollout/app-server turn-count mismatch は
diagnostic と app-server count 由来の rollback `numTurns` 補正に使う。
`restoreSafety.status = risk`、planned restore-safety risk、host primitive audit は
diagnostic-only として扱う。developer memory inject は item-level で、現行 Codex
host では即時 `thread/read` の turn count を増やさない場合がある。durable success は
rollout 上の新 rollback event と injected active-work memory evidence で判定する。
Claude 側 `/rewind` UX / 自動化 surface は次段階で、Codex current-thread trim を
新規 thread handoff に置き換えない。

[docs/07_codex_trim_implementation_plan.md](docs/07_codex_trim_implementation_plan.md) は旧統合計画と実装履歴として参照する。

作業量や複雑さを理由に理想を下げない。ただし、未検証の host behavior を確定仕様として実装しない。

## 実装規律

- フォールバックや silent recovery で失敗を隠さない。互換モードを使う場合は条件と理由を明示する。
- 新しい Markdown を増やす前に、既存 docs に追記できないか確認する。
- 進捗を計画書と `CLAUDE.md` の該当箇所にそろえて残す。README はユーザー向け仕様なので、実装済み behavior だけを載せる。
- source が正、docs は追従物。判断に迷ったらコードを読む。
- テストは `CLAUDE.md` の推奨コマンドを基準に、変更範囲に応じて追加する。
