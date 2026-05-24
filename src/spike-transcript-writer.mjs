/**
 * SPIKE ONLY — Phase 0-2 / 0-4 検証用。本実装ではない。
 *
 * docs/THROUGHLINE_TRANSCRIPT_INJECTION_PLAN.md Phase 0-2 で
 * 「`/clear` 直後の SessionStart hook 内で transcript_path に L2 を user/assistant
 *  role 付きで append すると、Claude が次の short prompt の文脈として読むか」を実機検証する。
 *
 * 本実装ではない理由:
 *   - text content のみ復元 (tool_use / tool_result / thinking は割愛)
 *   - idempotency 簡易チェックのみ
 *   - 本実装 (Phase 1-1) では src/transcript-writer.mjs を別途作る
 *
 * tracer 経路: 注入した JSONL 行が**モデルの message 履歴に乗ったか**を切り分けるため、
 * 最終 assistant 行末尾に **stdout 注入には含まれない一意トークン** を付与する。
 * 次の /clear 後にユーザーがその合言葉の再現を求め、Claude が答えられれば JSONL 経路は
 * モデル可視。答えられなければ JSONL は保持されてもメッセージ履歴に乗らない (孤立 chain
 * 等が原因)。
 *
 * marker file `~/.throughline/spike-inject.flag` 削除で spike は無効化される。
 */

import { readFileSync, existsSync, fsyncSync, openSync, closeSync, writeSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { buildHandoffRecord } from './handoff-record.mjs';

/**
 * targetJsonl の末尾行の uuid を返す。chain 設計案 (b) の親決定用。
 * file が無い / 空 / uuid 持ち行が無い場合は null を返す。
 */
function readLastUuid(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const o = JSON.parse(lines[i]);
      if (typeof o.uuid === 'string') return o.uuid;
    } catch {
      // skip non-json line
    }
  }
  return null;
}

function buildUserLine({ b, parentUuid, newSessionId, cwd, version, gitBranch }) {
  const uuid = randomUUID();
  const ts = new Date(b.createdAt ?? Date.now()).toISOString();
  const obj = {
    parentUuid,
    isSidechain: false,
    promptId: randomUUID(),
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: b.text ?? '' }],
    },
    uuid,
    timestamp: ts,
    permissionMode: 'auto',
    userType: 'external',
    entrypoint: 'claude-vscode',
    cwd,
    sessionId: newSessionId,
    version,
    gitBranch,
  };
  return { uuid, line: JSON.stringify(obj) };
}

function buildAssistantLine({ b, parentUuid, newSessionId, cwd, version, gitBranch, tracer, assistantModel }) {
  const uuid = randomUUID();
  const ts = new Date(b.createdAt ?? Date.now()).toISOString();
  const baseText = b.text ?? '';
  const text = tracer ? `${baseText}\n\n[spike-tracer: ${tracer}]` : baseText;
  const obj = {
    parentUuid,
    isSidechain: false,
    message: {
      model: assistantModel,
      id: `msg_spike_${uuid.slice(0, 8)}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    requestId: `req_spike_${uuid.slice(0, 8)}`,
    type: 'assistant',
    uuid,
    timestamp: ts,
    userType: 'external',
    entrypoint: 'claude-vscode',
    cwd,
    sessionId: newSessionId,
    version,
    gitBranch,
  };
  return { uuid, line: JSON.stringify(obj) };
}

/**
 * 末尾 assistant 行に埋める tracer を生成する。8 hex (32 bit)。
 * stdout 注入には含まれない値である必要があるため、DB body text とは無相関に乱数生成する。
 */
export function generateSpikeTracer() {
  return randomBytes(4).toString('hex');
}

/**
 * spike append. fsync 付きで JSONL に user/assistant 行を append する。
 *
 * @param {object} opts
 * @param {string|null} [opts.tracer] 末尾 assistant 行に付与する一意トークン。
 *   未指定なら付与しない (back-compat: 既存呼び出し用)。
 * @returns {{
 *   appended: number,
 *   parentUuidStart: string|null,
 *   tracer: string|null,
 *   tracerAppendedAt: number|null,
 *   skipReason?: string
 * }}
 */
// Phase 0-5 retry: 偽モデル名 ('claude-throughline-spike') では Claude Code が messages[]
// 構築時にフィルタしている可能性があるため、デフォルトは実在 Claude モデル名にする。
const DEFAULT_SPIKE_ASSISTANT_MODEL = 'claude-opus-4-7';

export function spikeInject({
  db,
  targetJsonlPath,
  newSessionId,
  cwd,
  version,
  gitBranch,
  tracer = null,
  assistantModel = DEFAULT_SPIKE_ASSISTANT_MODEL,
}) {
  const record = buildHandoffRecord(db, { sessionId: newSessionId, isInheritance: true });
  if (!record || !record.memory?.recentBodies?.length) {
    return {
      appended: 0,
      parentUuidStart: null,
      tracer: null,
      tracerAppendedAt: null,
      skipReason: 'no_record_or_empty_l2',
    };
  }
  const bodies = record.memory.recentBodies; // 古い順

  // 末尾 assistant 行を 1 件特定 (assistant が必ず末尾とは限らないため後ろから探す)。
  let lastAssistantIdx = -1;
  for (let i = bodies.length - 1; i >= 0; i -= 1) {
    if (bodies[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  let parentUuid = readLastUuid(targetJsonlPath);
  const parentUuidStart = parentUuid;
  const lines = [];
  let tracerAppendedAt = null;
  for (let i = 0; i < bodies.length; i += 1) {
    const b = bodies[i];
    const isLastAssistant = Boolean(tracer) && i === lastAssistantIdx;
    const built = b.role === 'user'
      ? buildUserLine({ b, parentUuid, newSessionId, cwd, version, gitBranch })
      : buildAssistantLine({
          b,
          parentUuid,
          newSessionId,
          cwd,
          version,
          gitBranch,
          tracer: isLastAssistant ? tracer : null,
          assistantModel,
        });
    if (isLastAssistant) tracerAppendedAt = i;
    lines.push(built.line);
    parentUuid = built.uuid;
  }
  // sync write + fsync で hook 終了前に確実に flush
  const fd = openSync(targetJsonlPath, 'a');
  try {
    writeSync(fd, lines.join('\n') + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return {
    appended: lines.length,
    parentUuidStart,
    tracer: tracer ?? null,
    tracerAppendedAt,
  };
}
