/**
 * 共有定数。
 * - 複数モジュールが同じ文字列リテラルで分岐する値はここに集約する。
 * - 値は SQL に書き込む列値とも一致させる（schema v5 details.kind）。
 */

/** L3 (details テーブル) の kind 列取り得る値 */
export const DETAIL_KIND = Object.freeze({
  TOOL_INPUT: 'tool_input',
  TOOL_OUTPUT: 'tool_output',
  SYSTEM: 'system',
  IMAGE: 'image',
  THINKING: 'thinking',
});

/** 上記の値すべての Set（未知値判定に使う） */
export const DETAIL_KIND_VALUES = new Set(Object.values(DETAIL_KIND));
