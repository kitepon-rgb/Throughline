import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { listCodexThreadCandidates } from './codex-thread-index.mjs';
import { parseCodexRolloutFile } from './codex-rollout-memory.mjs';
import { hashAuditorBody } from './body-digest.mjs';
import { buildBodyRowsFromActiveTurns, buildCodexThroughlineSessionId } from './codex-capture.mjs';
import { readCompletedTurnReceiptSnapshot } from './completed-turn-receipts.mjs';
import { readCompletedPairProjection } from './auditor-context.mjs';

export const OBSERVER_CURSOR_SCHEMA = 'throughline.observer_cursor.v1';
const CURSOR_PREFIX = 'tlc1.';

/**
 * Resolves the latest completed-only parent and validates an optional opaque cursor.
 * This core intentionally returns identities only as SHA-256 values; body projection is later work.
 */
export function resolveObserverTurnFeed({ projectPath, cursor = null, codexHome, receiptOptions, dbPath, maxBodyChars, maxTotalChars } = {}) {
  const project = canonicalExistingProject(projectPath);
  const projectSha256 = sha256(project);
  const claude = claudeCandidates(project, receiptOptions);
  const codex = codexCandidates(project, codexHome);
  const candidates = [...claude, ...codex];
  if (cursor === null || cursor === undefined) {
    const selected = selectLatest(candidates);
    if (selected?.ambiguous) return { schema: OBSERVER_CURSOR_SCHEMA, status: 'ambiguous_parent', cursor: null };
    const current = selected ?? emptyCandidate();
    const throughCursor = encodeObserverCursor(cursorShape(current, projectSha256));
    return withProjection(publicResult('snapshot', null, throughCursor, current), current, project, { dbPath, maxBodyChars, maxTotalChars });
  }

  let prior;
  try { prior = decodeObserverCursor(cursor); } catch { return { schema: OBSERVER_CURSOR_SCHEMA, status: 'resync_required', afterCursor: cursor, throughCursor: null }; }
  if (prior.schema !== OBSERVER_CURSOR_SCHEMA || prior.project_sha256 !== projectSha256) {
    return { schema: OBSERVER_CURSOR_SCHEMA, status: 'resync_required', afterCursor: cursor, throughCursor: null };
  }
  const priorCandidate = prior.host === null
    ? emptyCandidate()
    : candidates.find((item) => item.host === prior.host && item.threadHash === prior.thread_sha256);
  if (!priorCandidate || prior.host !== null &&
    (prior.history_floor < priorCandidate.historyFloor || prior.length > priorCandidate.chain.length ||
      prefixDigest(priorCandidate.chain.slice(0, prior.length)) !== prior.prefix_sha256)) {
    return { schema: OBSERVER_CURSOR_SCHEMA, status: 'resync_required', afterCursor: cursor, throughCursor: null };
  }
  const selected = selectLatest(candidates);
  if (selected?.ambiguous) return { schema: OBSERVER_CURSOR_SCHEMA, status: 'ambiguous_parent', cursor: null };
  const current = selected ?? emptyCandidate();
  const throughCursor = encodeObserverCursor(cursorShape(current, projectSha256));
  const status = prior.host === null && current.host !== null ? 'append'
    : prior.host !== null && current.host === null ? 'resync_required'
      : prior.host !== current.host ? 'host_switched'
        : prior.thread_sha256 !== current.threadHash ? 'thread_switched'
          : prior.length === current.chain.length ? 'unchanged' : 'append';
  return withProjection(publicResult(status, cursor, throughCursor, current), current, project, { dbPath, maxBodyChars, maxTotalChars });
}

export function encodeObserverCursor(value) {
  validateCursorShape(value);
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

export function decodeObserverCursor(token) {
  if (typeof token !== 'string' || token.length > 4096 || !token.startsWith(CURSOR_PREFIX)) {
    throw new TypeError('observer cursor invalid');
  }
  let value;
  try { value = JSON.parse(Buffer.from(token.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')); } catch { throw new TypeError('observer cursor invalid'); }
  validateCursorShape(value);
  return value;
}

function claudeCandidates(projectPath, receiptOptions) {
  const snapshot = readCompletedTurnReceiptSnapshot({ projectPath, ...(receiptOptions ?? {}) });
  const grouped = new Map();
  for (const receipt of snapshot.receipts) {
    const threadHash = sha256(receipt.target_session_id);
    const chain = grouped.get(threadHash) ?? [];
    chain.push({
      host: 'claude', thread_sha256: threadHash, origin_sha256: sha256(receipt.origin_session_id),
      user_sha256: receipt.user_sha256, assistant_sha256: receipt.assistant_sha256,
      completed_at: receipt.completed_at, source_sha256: sha256(`claude:${receipt.sequence}`), _sessionId: receipt.target_session_id,
    });
    grouped.set(threadHash, chain);
  }
  return [...grouped].map(([threadHash, chain]) => candidate('claude', threadHash, chain, snapshot.history_floor, chain.at(-1)?._sessionId ?? null));
}

function codexCandidates(projectPath, codexHome) {
  return listCodexThreadCandidates({ codexHome, projectPath, limit: Number.MAX_SAFE_INTEGER })
    .map((item) => {
      const parsed = parseCodexRolloutFile(item.rolloutPath);
      const chain = parsed.activeTurns.flatMap((turn) => codexTurnEntry(turn, item.id, item.rolloutPath));
      return candidate('codex', sha256(item.id), chain, 1, buildCodexThroughlineSessionId(item.id));
    })
    .filter((item) => item.chain.length > 0);
}

function codexTurnEntry(turn, threadId, rolloutPath) {
  if (!Number.isSafeInteger(turn.completedAt) || turn.completedAt < 0) return [];
  const sessionId = buildCodexThroughlineSessionId(threadId);
  const rows = buildBodyRowsFromActiveTurns([turn], { sessionId, now: turn.completedAt });
  const user = rows.find((row) => row.role === 'user');
  const assistant = rows.find((row) => row.role === 'assistant');
  if (!user || !assistant) return [];
  return [{
    host: 'codex', thread_sha256: sha256(threadId), origin_sha256: sha256(threadId),
    user_sha256: hashAuditorBody(user.text), assistant_sha256: hashAuditorBody(assistant.text),
    completed_at: turn.completedAt, source_sha256: sha256(`${rolloutPath}\0${turn.number}`),
  }];
}

function candidate(host, threadHash, chain, historyFloor, sessionId) {
  return { host, threadHash, chain, historyFloor, latestAt: chain.at(-1)?.completed_at ?? -1,
    sourceHash: chain.at(-1)?.source_sha256 ?? sha256(`${host}:${threadHash}`), sessionId };
}

function emptyCandidate() { return { host: null, threadHash: null, chain: [], historyFloor: 1, latestAt: -1, sourceHash: null }; }

function selectLatest(candidates) {
  if (candidates.length === 0) return null;
  const latestAt = Math.max(...candidates.map((item) => item.latestAt));
  const latest = candidates.filter((item) => item.latestAt === latestAt);
  if (new Set(latest.map((item) => item.host)).size > 1) return { ambiguous: true };
  return latest.sort((a, b) => b.threadHash.localeCompare(a.threadHash) || b.sourceHash.localeCompare(a.sourceHash))[0];
}

function cursorShape(current, projectSha256) {
  return {
    schema: OBSERVER_CURSOR_SCHEMA, project_sha256: projectSha256, host: current.host,
    thread_sha256: current.threadHash, history_floor: current.historyFloor,
    length: current.chain.length, prefix_sha256: prefixDigest(current.chain),
  };
}

function publicResult(status, afterCursor, throughCursor, current) {
  return {
    schema: OBSERVER_CURSOR_SCHEMA, status, afterCursor, throughCursor,
    host: current.host, thread_sha256: current.threadHash,
    chain: current.chain.map(({ _sessionId: _sessionId, ...entry }) => ({ ...entry })),
  };
}

function withProjection(result, current, projectPath, { dbPath, maxBodyChars, maxTotalChars }) {
  if (!dbPath || current.chain.length === 0 || result.status === 'resync_required') return result;
  const projection = readCompletedPairProjection({
    dbPath, sessionId: current.sessionId, projectRoot: projectPath,
    expectedPairs: current.chain.map(({ origin_sha256, user_sha256, assistant_sha256 }) => ({ origin_sha256, user_sha256, assistant_sha256 })),
    ...(maxBodyChars === undefined ? {} : { maxBodyChars }),
    ...(maxTotalChars === undefined ? {} : { maxTotalChars }),
  });
  if (projection.status === 'pending') return { ...result, status: 'projection_pending', throughCursor: null, turns: [] };
  return { ...result, turns: projection.turns };
}

function prefixDigest(chain) {
  return sha256(chain.map((entry) => [entry.host, entry.thread_sha256, entry.origin_sha256,
    entry.user_sha256, entry.assistant_sha256, entry.completed_at, entry.source_sha256].join('\0')).join('\n'));
}

function canonicalExistingProject(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || !existsSync(value) || !statSync(value).isDirectory()) {
    throw new TypeError('projectPath must be an existing absolute directory');
  }
  return realpathSync.native(value);
}

function sha256(value) { return createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function isSha256(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function validateCursorShape(value) {
  const keys = ['schema', 'project_sha256', 'host', 'thread_sha256', 'history_floor', 'length', 'prefix_sha256'];
  const emptyPrefix = prefixDigest([]);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value)) || value.schema !== OBSERVER_CURSOR_SCHEMA || !isSha256(value.project_sha256) ||
    !isSha256(value.prefix_sha256) || !Number.isSafeInteger(value.history_floor) || value.history_floor < 1 ||
    !Number.isSafeInteger(value.length) || value.length < 0 ||
    !((value.host === null && value.thread_sha256 === null && value.length === 0 && value.history_floor === 1 && value.prefix_sha256 === emptyPrefix) ||
      (['claude', 'codex'].includes(value.host) && isSha256(value.thread_sha256) && value.length >= 1))) {
    throw new TypeError('observer cursor invalid');
  }
}
