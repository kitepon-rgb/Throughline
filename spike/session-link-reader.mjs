// SessionStart フック追加: state ファイルから旧 session_id を読み、
// 10 秒窓内なら新 session_id と紐づけてファイルを closed にする
import { readStdinSync, readState, writeState, appendLog, WINDOW_MS } from './session-link-common.mjs';

const raw = readStdinSync();
let parsed = null;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  appendLog({ op: 'read-error', reason: 'parse-failed', raw: raw.slice(0, 200) });
  process.exit(0);
}

const new_session_id = parsed?.session_id;
const new_transcript_path = parsed?.transcript_path || null;
const source = parsed?.source || null;
const cwd = parsed?.cwd || process.cwd();

if (!new_session_id) {
  appendLog({ op: 'read-error', reason: 'no-session-id', parsed });
  process.exit(0);
}

const state = readState(cwd);

if (!state) {
  appendLog({ op: 'read-miss-empty', cwd, new_session_id, source });
  process.exit(0);
}

if (state.state !== 'open') {
  appendLog({ op: 'read-miss-closed', cwd, new_session_id, source, current_state: state.state, old_session_id: state.old_session_id });
  process.exit(0);
}

const elapsed = Date.now() - Number(state.ts || 0);
if (elapsed > WINDOW_MS) {
  appendLog({ op: 'read-miss-stale', cwd, new_session_id, source, elapsed_ms: elapsed, old_session_id: state.old_session_id });
  process.exit(0);
}

if (state.old_session_id === new_session_id) {
  appendLog({ op: 'read-miss-self', cwd, new_session_id, source, elapsed_ms: elapsed });
  process.exit(0);
}

// 成功: リンク記録 + state を closed に
const linked = {
  old: state.old_session_id,
  new: new_session_id,
  cwd,
  old_transcript_path: state.transcript_path,
  new_transcript_path,
  elapsed_ms: elapsed,
  source,
};
appendLog({ op: 'link-success', ...linked });

try {
  writeState(cwd, {
    ...state,
    state: 'closed',
    closed_at: Date.now(),
    linked_to: new_session_id,
  });
  appendLog({ op: 'state-closed', cwd, old_session_id: state.old_session_id, new_session_id });
} catch (e) {
  appendLog({ op: 'close-error', reason: String(e), cwd });
}

process.exit(0);
