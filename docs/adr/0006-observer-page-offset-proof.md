# ADR 0006: Observer page tokenのoffsetをseries prefix digestで検証する

日付: 2026-07-15

置換対象: [ADR 0005](0005-observer-read-pagination.md) Decision 3・4のoffset検証

## Context

ADR 0005はpage tokenをproject、after cursor、through cursor、offsetへ束縛したが、offset自身を
固定seriesの内容へ束縛していない。tokenをdecodeできる呼出側がoffsetだけを別の範囲内整数へ変えると、
schemaとcursor hashは一致したままturnを飛ばせる。page tokenは認可credentialではないが、破損・
取り違え・誤実装をsilent skipとして受理してはならない。

ADR 0005はControl Decisionの不変証拠なので追記修正せず、本ADRで不足契約だけを置換する。

## Decision

1. `throughline.observer_page.v1`へ`offset_prefix_sha256`を必須追加する。
2. digest入力は、after/throughから導いた固定logical seriesの先頭からoffset直前までの各turnについて、
   host、hash-only thread identity、origin/user/assistant SHA-256、completion時刻、source SHA-256を
   canonical順で結合したものとする。offset 0はempty prefixのSHA-256を使う。
3. page token decode後、project/after/through hash、offsetの範囲に加え、現在再構成した固定seriesの
   prefix digestと`offset_prefix_sha256`を完全一致で検証する。一つでも違えばhard input errorとし、
   別offsetへの推測や最寄り境界への補正をしない。
4. 次page tokenは、今回返したturn数を加算した次offsetと、その位置のprefix digestからだけ生成する。
5. tokenはlocal continuation tokenであり認可credentialではない。攻撃者に対するMACの代用とは扱わず、
   信頼境界を越えて受ける将来transportでは、Observer側認可とtransport integrityを別に要求する。

## Consequences

- offsetだけの破損・取り違えでturnをsilent skipできない。
- rollbackや固定through chainの内容変化もprefix不一致として明示拒否される。
- cursor contractと同じcontent-addressed検証を再利用でき、秘密鍵や永続server stateを追加しない。
