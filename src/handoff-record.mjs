/**
 * Agent-neutral handoff projection.
 *
 * This module reads the same persisted memory that Claude resume-context uses,
 * but returns a stable object instead of Claude-facing Markdown. It is not
 * persisted to DB; adapters can render it for Claude, Codex, or diagnostics.
 */

import { CODEX_SESSION_PREFIX } from './hosts/identity.mjs';

export const HANDOFF_RECORD_VERSION = 1;
export const N_RECENT_L2 = 20;
export { CODEX_SESSION_PREFIX };

const DEFAULT_INTENT = 'continue implementation';
const DEFAULT_CONSTRAINTS = [
  'preserve existing Claude Code hook, slash command, transcript, baton, and resume behavior',
  'add Codex support as adapter/projection; do not rename Claude-facing DB fields or commands',
  'do not treat unverified rollback/inject host behavior as a confirmed implementation contract',
];

/**
 * Unix ms を HH:MM:SS 形式に変換する。
 */
export function formatTime(unixMs) {
  const d = new Date(unixMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function loadSession(db, sessionId) {
  try {
    return db
      .prepare(
        `SELECT session_id, project_path, status, created_at, updated_at, merged_into
         FROM sessions
         WHERE session_id = ?`,
      )
      .get(sessionId) ?? null;
  } catch {
    return null;
  }
}

function buildBodySet(rows) {
  return new Set(rows.map((r) => `${r.origin_session_id}\x00${r.turn_number}`));
}

function distinctOriginSessionIds(...rowGroups) {
  const ids = new Set();
  for (const rows of rowGroups) {
    for (const r of rows) {
      if (r.origin_session_id) ids.add(r.origin_session_id);
    }
  }
  return [...ids].sort();
}

function inferSourceAdapter(sessionId, originSessionIds) {
  const ids = [sessionId, ...originSessionIds].filter(Boolean);
  if (ids.length > 0 && ids.every((id) => String(id).startsWith(CODEX_SESSION_PREFIX))) {
    return 'codex';
  }
  return 'claude';
}

function loadBodies(db, { sessionId, excludeOriginId, recentTurnLimit }) {
  const hasExclude = Boolean(excludeOriginId);
  const bodiesQuery = hasExclude
    ? `SELECT origin_session_id, turn_number, role, text, created_at
       FROM bodies
       WHERE session_id = ? AND origin_session_id != ?
       ORDER BY created_at DESC`
    : `SELECT origin_session_id, turn_number, role, text, created_at
       FROM bodies
       WHERE session_id = ?
       ORDER BY created_at DESC`;

  let desc = [];
  try {
    desc = hasExclude
      ? db.prepare(bodiesQuery).all(sessionId, excludeOriginId)
      : db.prepare(bodiesQuery).all(sessionId);
  } catch {
    desc = [];
  }

  const selectedTurns = new Set();
  const selectedRows = [];
  for (const row of desc) {
    const key = `${row.origin_session_id}\x00${row.turn_number}`;
    if (!selectedTurns.has(key)) {
      if (selectedTurns.size >= recentTurnLimit) continue;
      selectedTurns.add(key);
    }
    selectedRows.push(row);
  }

  return selectedRows.reverse();
}

function loadL1Summaries(db, { sessionId, excludeOriginId, bodyRows }) {
  const hasExclude = Boolean(excludeOriginId);
  const skelQuery = hasExclude
    ? `SELECT origin_session_id, turn_number, role, summary, created_at
       FROM skeletons
       WHERE session_id = ? AND origin_session_id != ?
       ORDER BY created_at ASC`
    : `SELECT origin_session_id, turn_number, role, summary, created_at
       FROM skeletons
       WHERE session_id = ?
       ORDER BY created_at ASC`;

  let all = [];
  try {
    all = hasExclude
      ? db.prepare(skelQuery).all(sessionId, excludeOriginId)
      : db.prepare(skelQuery).all(sessionId);
  } catch {
    all = [];
  }
  const bodySet = buildBodySet(bodyRows);
  return all.filter((s) => !bodySet.has(`${s.origin_session_id}\x00${s.turn_number}`));
}

/**
 * L1 ターンの元 body 時刻 (created_at MIN) を batch lookup する。
 * skeletons.created_at は要約実行時刻なので `throughline detail HH:MM:SS` 解決に
 * 使えない。元 body は trim 後も bodies テーブルに残っているのが通常で、
 * (session_id, origin_session_id, turn_number) で MIN を引けば原ターンの時刻が得られる。
 */
function loadL1BodyTimes(db, sessionId, l1Rows) {
  if (!l1Rows || l1Rows.length === 0) return new Map();
  const tuples = l1Rows
    .filter((r) => r.origin_session_id != null && r.turn_number != null)
    .map((r) => [r.origin_session_id, Number(r.turn_number)]);
  if (tuples.length === 0) return new Map();

  const placeholders = tuples.map(() => '(?, ?, ?)').join(', ');
  const params = tuples.flatMap(([origin, turn]) => [sessionId, origin, turn]);

  const out = new Map();
  try {
    const rows = db
      .prepare(
        `SELECT origin_session_id, turn_number, MIN(created_at) AS created_at
         FROM bodies
         WHERE (session_id, origin_session_id, turn_number) IN (VALUES ${placeholders})
         GROUP BY origin_session_id, turn_number`,
      )
      .all(...params);
    for (const r of rows) {
      out.set(`${r.origin_session_id}\x00${r.turn_number}`, r.created_at);
    }
  } catch {
    // body が無い defensive ケースでは bodyTime null のまま (renderer 側で skeleton 時刻 fallback)
  }
  return out;
}

function loadLatestThinking(db, { sessionId, excludeOriginId }) {
  const hasExclude = Boolean(excludeOriginId);
  const latestQuery = hasExclude
    ? `SELECT origin_session_id, turn_number, created_at
       FROM bodies
       WHERE session_id = ? AND origin_session_id != ? AND role = 'assistant'
       ORDER BY created_at DESC
       LIMIT 1`
    : `SELECT origin_session_id, turn_number, created_at
       FROM bodies
       WHERE session_id = ? AND role = 'assistant'
       ORDER BY created_at DESC
       LIMIT 1`;

  let latest;
  try {
    latest = hasExclude
      ? db.prepare(latestQuery).get(sessionId, excludeOriginId)
      : db.prepare(latestQuery).get(sessionId);
  } catch {
    return [];
  }
  if (!latest) return [];

  try {
    return db
      .prepare(
        `SELECT origin_session_id, turn_number, output_text, created_at, source_id
         FROM details
         WHERE session_id = ? AND origin_session_id = ? AND turn_number = ? AND kind = 'thinking'
         ORDER BY created_at ASC`,
      )
      .all(sessionId, latest.origin_session_id, latest.turn_number)
      .filter((r) => typeof r.output_text === 'string' && r.output_text.length > 0);
  } catch {
    return [];
  }
}

function loadL3References(db, { sessionId, bodyRows }) {
  const turnKeys = [...buildBodySet(bodyRows)];
  if (turnKeys.length === 0) return [];

  const tuples = turnKeys.map((k) => k.split('\x00'));
  const placeholders = tuples.map(() => '(?, ?, ?)').join(', ');
  const params = tuples.flatMap(([origin, turn]) => [sessionId, origin, Number(turn)]);

  try {
    return db
      .prepare(
        `SELECT kind, tool_name, source_id, origin_session_id, turn_number, created_at
         FROM details
         WHERE (session_id, origin_session_id, turn_number) IN (VALUES ${placeholders})
         ORDER BY created_at ASC, id ASC`,
      )
      .all(...params)
      .map((r) => ({
        kind: r.kind,
        toolName: r.tool_name,
        sourceId: r.source_id ?? null,
        originSessionId: r.origin_session_id,
        turnNumber: r.turn_number,
        createdAt: r.created_at,
        detailCommand: `throughline detail ${formatTime(r.created_at)}`,
      }));
  } catch {
    return [];
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   sessionId: string,
 *   isInheritance?: boolean,
 *   excludeOriginId?: string | null,
 *   inflightMemo?: string | null,
 *   intent?: string,
 *   constraints?: string[],
 *   recentTurnLimit?: number,
 * }} params
 */
export function buildHandoffRecord(
  db,
  {
    sessionId,
    isInheritance = false,
    excludeOriginId = null,
    inflightMemo = null,
    intent = DEFAULT_INTENT,
    constraints = DEFAULT_CONSTRAINTS,
    recentTurnLimit = N_RECENT_L2,
  },
) {
  if (!sessionId) return null;

  const session = loadSession(db, sessionId);
  const bodyRows = loadBodies(db, { sessionId, excludeOriginId, recentTurnLimit });
  const l1Rows = loadL1Summaries(db, { sessionId, excludeOriginId, bodyRows });
  const thinkingRows = loadLatestThinking(db, { sessionId, excludeOriginId });

  if (
    bodyRows.length === 0 &&
    l1Rows.length === 0 &&
    thinkingRows.length === 0 &&
    !inflightMemo
  ) {
    return null;
  }

  const l3References = loadL3References(db, { sessionId, bodyRows });
  const l1BodyTimes = loadL1BodyTimes(db, sessionId, l1Rows);
  const originSessionIds = distinctOriginSessionIds(bodyRows, l1Rows, thinkingRows);

  return {
    kind: 'handoff_record',
    version: HANDOFF_RECORD_VERSION,
    session: {
      id: sessionId,
      projectPath: session?.project_path ?? null,
      status: session?.status ?? null,
      mergedInto: session?.merged_into ?? null,
    },
    source: {
      adapter: inferSourceAdapter(sessionId, originSessionIds),
      inheritance: Boolean(isInheritance),
      excludeOriginId: excludeOriginId ?? null,
      originSessionIds,
    },
    intent,
    constraints: [...constraints],
    memory: {
      inflightMemo: inflightMemo && inflightMemo.trim().length > 0 ? inflightMemo.trim() : null,
      latestThinking: thinkingRows.map((r) => ({
        originSessionId: r.origin_session_id,
        turnNumber: r.turn_number,
        text: r.output_text,
        createdAt: r.created_at,
        time: formatTime(r.created_at),
        sourceId: r.source_id ?? null,
      })),
      l1Summaries: l1Rows.map((r) => {
        const bodyTimeMs = l1BodyTimes.get(`${r.origin_session_id}\x00${r.turn_number}`);
        return {
          originSessionId: r.origin_session_id,
          turnNumber: r.turn_number,
          role: r.role,
          summary: r.summary,
          createdAt: r.created_at,
          time: formatTime(r.created_at),
          // 元ターンの body 時刻。`throughline detail HH:MM:SS` 解決に使える時刻。
          // body が無い defensive ケースでは null。
          bodyTimeMs: bodyTimeMs ?? null,
          bodyTime: bodyTimeMs != null ? formatTime(bodyTimeMs) : null,
        };
      }),
      recentBodies: bodyRows.map((r) => ({
        originSessionId: r.origin_session_id,
        turnNumber: r.turn_number,
        role: r.role,
        text: r.text,
        createdAt: r.created_at,
        time: formatTime(r.created_at),
      })),
    },
    references: {
      l3: l3References,
    },
    stats: {
      l1Rows: l1Rows.length,
      l2Rows: bodyRows.length,
      thinkingRows: thinkingRows.length,
      l3References: l3References.length,
      preservedContextRows: bodyRows.length + l1Rows.length,
    },
  };
}
