---
name: "source-command-tl"
description: "次の新規セッションに現セッションの記憶を引き継ぐためのバトンを置く (Throughline)"
---

# source-command-tl

Use this skill when the user asks to run the migrated source command `tl`.

## Command Template

Throughline の UserPromptSubmit hook が `/tl` を検出し、バトン（現セッション ID）を保存しました。

これだけで完了です。**追加の操作は不要**。

このあと:
- 1 時間以内に新セッションを開く（新 chat / VSCode 再起動など）と、Throughline がバトンを消費して前セッションの記憶 (L1 + L2 + L3 references) を新セッションに自動注入します
- バトンは 1 時間で失効します

通常は `/clear` だけで自動引継ぎが発火するため、`/tl` は **`THROUGHLINE_DISABLE_AUTO_HANDOFF=1` で自動引継ぎを OFF にしているユーザー** または **`/clear` を経由せずに新セッションを開くケース** の明示意思マーカーとして使います。

ユーザーへの追加報告テキストは不要です。一言だけ完了を伝えるか、何も返さずターンを終えて構いません。
