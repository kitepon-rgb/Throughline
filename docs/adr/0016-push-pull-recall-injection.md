# ADR 0016: 注入の push/pull 再設計 — 現在地 + 入るだけ L2 の push と recall CLI による pull

- Status: accepted (2026-07-18 オーナー裁定)
- 関連: [ADR 0014](0014-two-phase-handoff-ghost-baton.md)（9,500 字注入予算）、
  [ADR 0015](0015-l1-summarizer-model-effort-ratio.md)（L1 要約体制）

## 問題

9,500 字の注入予算（hook stdout ~10k で `<persisted-output>` file 化、ADR 0014）の中で、
旧 `buildBudgetedResumeContext` は **L1 を先に詰めてから L2 を詰めて**いた。実測
（このMacのDB、L2 1 ターン中央値 ~800 字・平均 ~2,750 字）では L2 は 5〜10 ターンしか
入らず、しかも L1 生成は `L2_WINDOW = 20` より古いターンにしか走らない（Stop 毎 1 件の
遅延生成）ため、「予算落ちした 5〜20 ターン前」が **L2 も注入されず L1 も未生成**の
記憶空白帯になっていた。省略告知は時刻列挙のみで、取り出しは 1 ターンずつ
`throughline detail` を叩くしかなかった。

## 検討して不採用にした案

1. **固定 N ターン + per-role 切り詰めで L2 を保証し、残りに L1 充填**:
   L1 生成閾値を N に連動させる案。pull 設計に移った時点で、注入 L1 が pull の L2×残り
   と同じターンを二重に運ぶ矛盾が出て破棄（会話での敵対的整理）。固定 N 自体も
   「軽い会話で予算を設計的に遊ばせる」ため破棄。
2. **multi-hook による 10k 突破**: 実測で**可能**と確認した（下記「実測」）が、hook の
   構造的想定（1 本 = 1 context string）に無い使い方であり、attachment 順序も非決定の
   ため不採用。
3. **全文ログのファイル書き出し + Read 誘導**: DB が正本なのに派生ファイルの寿命管理が
   発生する。過去ターンのレコードは不変なので、スナップショット性は DB 直参照でも
   担保できる。CLI 経由の DB 直参照に統一して不採用。
4. **生 SQL をモデルに案内**: schema 講義で注入が太り、origin フィルタ等の誤クエリ事故面
   が開く。`detail` と同じ「DB 直参照だがモデルにはコマンド 1 発」の流儀で不採用。

## 決定

push は「現在地」に徹し、過去は pull に出す。

- **push（注入、9,500 字内）**: ヘッダ + 現在地アンカー + 案内セクション
  （固定部として最優先予約・無条件表示）+ 残り全予算に **L2 を新しい順で
  丸ごと入るターンだけ全文**（ターン単位の原子。固定 N なし・断片詰めなし・
  ターン境界の自然な端数は許容）。**L1 は注入しない**。
  最新ターンが単体で予算超過する場合だけ切り詰めて入れる（従来規則の維持）。
- **pull（新 CLI `throughline recall` = read-only DB 直参照）**:
  - `recall --l2 --session <id> --before <ISO8601 ms> --last <N>` —
    境界より古いターンを新しい側から N 件、L2 全文（注入と同じ行文法 + L3 suffix）
  - `recall --l1 --session <id> --before <ISO8601 ms> --skip <N>` —
    --l2 の担当分を飛ばした先の全ターン一覧。**L1 要約があれば要約、無ければ
    「未要約」と明示**して detail 誘導。冒頭に「全 M ターン / 要約済み K」を正直に表示
  - 一点掘りは従来どおり `throughline detail <時刻>`（L2+L3）
- **`L2_WINDOW = 20` は据え置き**。20 の意味が「push（入るだけ）+ pull（残り）」の
  合計窓に再定義されるだけで、L1 要約ペース・Codex 側・schema への変更なし。

### 間抜け防止 — 機械用境界の完全焼き込み（refuter 敵対的検証 2026-07-18）

実装前に refuter による敵対的検証を通し、real 指摘 6 件を全て設計へ反映した:

| 指摘 | 対処 |
|---|---|
| HH:MM:SS 境界は「当日」解決（sc-detail の `timeToUnixRange`）で深夜跨ぎに壊れる | `--before` は ISO 8601 完全日時（ms 精度）。表示用 HH:MM:SS と機械用境界を分離 |
| 秒切り捨てで同秒行の境界包含が未定義 | 境界は strict less-than の ms 比較で規定 |
| 20 ターン窓はクエリ時再計算のため、新セッションのターン追記で窓がスライドし古い側が黙って欠落 | `--last <残り件数>` も注入時に焼き込み、recall 側の窓再計算を全廃 |
| L1 は遅延生成でバックログがあり「全 N ターンの要約」が虚偽になる。未要約ターンがどの取っ手からも見えない | `--l1` は全ターン一覧（要約 or 未要約明示）。件数は「全 M / 要約済み K」形式 |
| 既定 session 解決（cwd 系）は Codex 併走・複数ウィンドウで非決定 | `--session` も焼き込み。recall は既定解決を持たない |
| `getDb()` は mkdir + read-write open + migration を行い read-only 契約に反する | recall は `DatabaseSync(path, { readOnly: true })` + 存在チェック。DB を作成しない |

併せて、予算詰めを行（role）単位からターン単位の原子に変更した（行単位だと同一ターンの
assistant 行だけ入り user 行が pull 側に半身で現れ、境界の算術が濁るため）。

## 実測

### 新設計のレンダリング（2026-07-18、実 DB 191 ターンセッション）

- totalChars 9,158 / 9,500、L2 9 ターン注入、残り 11 ターン、窓外 171 ターン
  （要約済み 124 / 未要約 47）
- 焼き込まれた案内コマンドをそのまま実行して、`--l2` が境界ぴったりから 11 ターン
  （33k 字）、`--l1` が全 171 ターン一覧（118k 字、`--last` で部分取得可）を返すことを確認

### multi-hook 10k 突破の実測（2026-07-18、Claude Code 2.1.211 / 不採用）

- 同一 UserPromptSubmit に hook を 3 本登録 → それぞれ独立の `hook_success` attachment
  になり 9,000 字 × 3 = 27,000 字が全部モデル可視 inline
- 1 本だけ 12k にすると**その 1 本だけ**が `<persisted-output>` 化（隣の 9k は無傷）
  = 10k 判定は per context string
- 5 本 × 9k = 45,000 字でも全部可視。合算上限は 45k まで観測されず
- **attachment の並び順は登録順と一致しない**（並列実行のため非決定）
- 詳細は [rag/01-hooks/hook-stdout-10k-persisted-output.md](../../rag/01-hooks/hook-stdout-10k-persisted-output.md)

## 帰結

- 「5〜20 ターン前の空白帯」は消滅: 窓内の非注入分は `recall --l2` が verbatim で、
  窓外は `recall --l1` が全ターン（未要約含む）で必ず到達可能
- push は会話密度に自動適応（中央値 7〜8 ターン、軽い会話なら 10 ターン超、重くて 2〜3）
- コンテキスト衛生は維持: pull はモデルが必要と判断した時だけ発生する
- `handoff-executor` の injection stats は
  `injected_l2_turns / remaining_l2_turns / older_turns / older_summarized` に更新
