#!/usr/bin/env node
/**
 * sc-detail — /sc-detail スラッシュコマンドの実行本体
 *
 * 使い方:
 *   node src/sc-detail.mjs <時刻>
 *   node src/sc-detail.mjs <開始時刻>-<終了時刻>
 *
 * 時刻フォーマット: HH:MM:SS または HH:MM（秒省略可）
 * 複数ターンが同一時刻にヒットする場合は全部返す。
 *
 * 出力: 指定時刻のターン（または範囲内の全ターン）の L2 (bodies) + L3 (details)
 *       を人間可読なテキストで stdout に出力する。
 *
 * 注意:
 *   - 現在の作業ディレクトリ（cwd）のプロジェクトに属するターンのみを対象にする
 *   - session_id は merge chain 解決後の合流先（target）を使う
 *   - 複数セッションの ID を跨いで時刻で検索するので、project_path でフィルタ必須
 */

import { getDb } from './db.mjs';
import { DETAIL_KIND, DETAIL_KIND_VALUES } from './constants.mjs';

function parseTimeArg(arg) {
  const m = String(arg || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, hh, mm, ss] = m;
  return {
    hours: Number(hh),
    minutes: Number(mm),
    seconds: ss != null ? Number(ss) : null, // null = 秒指定なし（その分内すべて）
  };
}

/**
 * 指定時刻（HH:MM:SS）の当日タイムスタンプ（ms）を返す。
 * 秒が null の場合は start=00, end=59 の範囲を返す（呼び出し側で使い分け）。
 */
function timeToUnixRange(t, baseDate = new Date()) {
  const y = baseDate.getFullYear();
  const mo = baseDate.getMonth();
  const d = baseDate.getDate();
  const secStart = t.seconds != null ? t.seconds : 0;
  const secEnd = t.seconds != null ? t.seconds : 59;
  const start = new Date(y, mo, d, t.hours, t.minutes, secStart, 0).getTime();
  const end = new Date(y, mo, d, t.hours, t.minutes, secEnd, 999).getTime();
  return { start, end };
}

function parseRangeArg(arg) {
  const s = String(arg || '').trim();
  if (!s.includes('-')) {
    const t = parseTimeArg(s);
    if (!t) return null;
    const r = timeToUnixRange(t);
    return { start: r.start, end: r.end };
  }
  const [lo, hi] = s.split('-').map((x) => x.trim());
  const tLo = parseTimeArg(lo);
  const tHi = parseTimeArg(hi);
  if (!tLo || !tHi) return null;
  const rLo = timeToUnixRange(tLo);
  const rHi = timeToUnixRange(tHi);
  return { start: rLo.start, end: rHi.end };
}

function formatTime(unixMs) {
  const d = new Date(unixMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * コアロジック。bin/throughline.mjs などから直接呼び出せるよう、
 * process.argv ではなく引数配列を受け取る。
 * @param {string[]} args
 */
export function run(args) {
  const arg = args[0];
  if (!arg) {
    process.stderr.write(
      '使い方: throughline detail <HH:MM:SS>\n' +
        '       throughline detail <HH:MM:SS>-<HH:MM:SS>\n',
    );
    process.exit(1);
  }

  const range = parseRangeArg(arg);
  if (!range) {
    process.stderr.write(`[sc-detail] 時刻フォーマットが無効: ${arg}\n`);
    process.exit(1);
  }

  const db = getDb();
  const projectPath = process.cwd();

  // 指定時刻範囲内のターンを bodies から取得（project_path でフィルタ）
  // bodies と sessions を JOIN して同プロジェクトに絞る
  const bodyRows = db
    .prepare(
      `SELECT b.session_id, b.origin_session_id, b.turn_number, b.role, b.text, b.created_at
       FROM bodies b
       JOIN sessions s ON s.session_id = b.session_id
       WHERE lower(s.project_path) = lower(?)
         AND b.created_at BETWEEN ? AND ?
       ORDER BY b.created_at ASC, b.role ASC`,
    )
    .all(projectPath, range.start, range.end);

  if (bodyRows.length === 0) {
    process.stdout.write(
      `## Throughline /sc-detail\n\n指定時刻 ${arg} に該当するターンが見つかりませんでした。\n`,
    );
    process.exit(0);
  }

  // ターン単位でグルーピング（同じ session_id + origin + turn_number）
  const turnKeys = new Set();
  for (const r of bodyRows) {
    turnKeys.add(`${r.session_id}\x00${r.origin_session_id}\x00${r.turn_number}`);
  }

  const lines = [];
  lines.push('## Throughline /sc-detail');
  lines.push(`指定時刻: ${arg}  対象ターン数: ${turnKeys.size}`);
  lines.push('');

  // L2 を時刻順に出力
  lines.push('### L2 (会話本文)');
  for (const r of bodyRows) {
    lines.push(`[${formatTime(r.created_at)}] [${r.role}]: ${r.text}`);
    lines.push('');
  }

  // 対応する L3 を details から 1 クエリで取得（N+1 回避のため row-value IN）
  const turnTuples = [...turnKeys].map((k) => k.split('\x00'));
  const placeholders = turnTuples.map(() => '(?, ?, ?)').join(', ');
  const params = turnTuples.flatMap(([sid, origin, turn]) => [sid, origin, Number(turn)]);
  const detailRows = db
    .prepare(
      `SELECT id, turn_number, kind, tool_name, input_text, output_text, created_at
       FROM details
       WHERE (session_id, origin_session_id, turn_number) IN (VALUES ${placeholders})
       ORDER BY id ASC`,
    )
    .all(...params);

  if (detailRows.length > 0) {
    // 単一 pass で kind ごとに振り分け
    const toolRows = [];
    const systemRows = [];
    const imageRows = [];
    const legacyRows = [];
    for (const d of detailRows) {
      if (d.kind === DETAIL_KIND.TOOL_INPUT || d.kind === DETAIL_KIND.TOOL_OUTPUT) toolRows.push(d);
      else if (d.kind === DETAIL_KIND.SYSTEM) systemRows.push(d);
      else if (d.kind === DETAIL_KIND.IMAGE) imageRows.push(d);
      else if (!DETAIL_KIND_VALUES.has(d.kind)) legacyRows.push(d);
    }

    if (toolRows.length > 0) {
      lines.push('### L3 (ツール入出力)');
      for (const d of toolRows) {
        const marker = d.kind === DETAIL_KIND.TOOL_INPUT ? 'IN ' : 'OUT';
        lines.push(`[${formatTime(d.created_at)}] ${marker} ${d.tool_name}`);
        if (d.input_text) {
          lines.push(`  IN:  ${d.input_text.replace(/\n/g, '\n       ')}`);
        }
        if (d.output_text) {
          lines.push(`  OUT: ${d.output_text.replace(/\n/g, '\n       ')}`);
        }
        lines.push('');
      }
    }

    if (systemRows.length > 0) {
      lines.push('### L3 (システムメッセージ / hook 出力)');
      for (const d of systemRows) {
        lines.push(`[${formatTime(d.created_at)}] ${d.tool_name}`);
        if (d.input_text) lines.push(`  CMD: ${d.input_text}`);
        if (d.output_text) lines.push(`  OUT: ${d.output_text.replace(/\n/g, '\n       ')}`);
        lines.push('');
      }
    }

    if (imageRows.length > 0) {
      lines.push('### L3 (画像)');
      for (const d of imageRows) {
        lines.push(`[${formatTime(d.created_at)}] ${d.output_text ?? '[image]'}`);
      }
      lines.push('');
    }

    if (legacyRows.length > 0) {
      lines.push('### L3 (legacy)');
      for (const d of legacyRows) {
        lines.push(`[${formatTime(d.created_at)}] ${d.tool_name}`);
        if (d.input_text) lines.push(`  IN:  ${d.input_text.replace(/\n/g, '\n       ')}`);
        if (d.output_text) lines.push(`  OUT: ${d.output_text.replace(/\n/g, '\n       ')}`);
        lines.push('');
      }
    }
  } else {
    lines.push('### L3');
    lines.push('（該当ターンに L3 レコード無し）');
  }

  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}
