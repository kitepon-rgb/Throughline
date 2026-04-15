/**
 * detail-capture.mjs
 * PostToolUse フックスクリプト。
 * Bash/Write/Edit/Read/Grep/Glob 実行後に Claude Code から呼ばれる。
 * stdin から JSON を受け取り、L3 詳細を SQLite の details テーブルに保存する。
 */

import { getDb } from './db.mjs'
import { estimateTokens } from './token-estimator.mjs'
import { resolveMergeTarget } from './session-merger.mjs'

// ---- シークレットマスキング ----

/** @type {Array<{pattern: RegExp, replacement: string}>} */
const MASK_RULES = [
  { pattern: /API_KEY=\S+/g, replacement: 'API_KEY=[MASKED]' },
  { pattern: /Bearer \S+/g, replacement: 'Bearer [MASKED]' },
  { pattern: /sk-[A-Za-z0-9]+/g, replacement: '[MASKED]' },
  { pattern: /"password":\s*"[^"]*"/g, replacement: '"password": "[MASKED]"' },
]

/**
 * テキスト中のシークレットをマスクして返す。
 * @param {string} text
 * @returns {string}
 */
function maskSecrets(text) {
  if (typeof text !== 'string') return text
  let result = text
  for (const { pattern, replacement } of MASK_RULES) {
    result = result.replace(pattern, replacement)
  }
  return result
}

// ---- stdin 読み込み ----

/**
 * process.stdin を全部読んで文字列を返す（Windows 互換）。
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

// ---- メイン処理 ----

async function main() {
  const raw = await readStdin()

  /** @type {{session_id?: string, tool_name?: string, tool_input?: unknown, tool_response?: unknown, transcript_path?: string}} */
  const payload = JSON.parse(raw)

  const { session_id, tool_name, tool_input, tool_response } = payload

  if (!session_id) throw new Error('Missing session_id in PostToolUse payload')

  // tool_input / tool_response を文字列に変換
  const rawInputText =
    typeof tool_input === 'string' ? tool_input : JSON.stringify(tool_input ?? '')
  const rawOutputText =
    typeof tool_response === 'string' ? tool_response : JSON.stringify(tool_response ?? '')

  // シークレットマスキング
  const input_text = maskSecrets(rawInputText)
  const output_text = maskSecrets(rawOutputText)

  // トークン数推定（入力 + 出力の合計）
  const token_count = estimateTokens(input_text) + estimateTokens(output_text)

  // DB 操作
  const db = getDb()

  // merge target 解決: 入力 session が既に合流済みなら target = 合流先
  const { target, origin } = resolveMergeTarget(db, session_id)

  // target の sessions テーブル行がなければ INSERT
  const existing = db
    .prepare('SELECT session_id FROM sessions WHERE lower(session_id) = lower(?)')
    .get(target)

  if (!existing) {
    const now = Date.now()
    db.prepare(
      'INSERT INTO sessions (session_id, project_path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(target, payload.cwd ?? process.cwd(), 'active', now, now)
  }

  // details テーブルに INSERT（turn_number = NULL: Stop フック時に確定）
  const now = Date.now()
  db.prepare(
    `INSERT INTO details
       (session_id, origin_session_id, turn_number, tool_name, input_text, output_text, token_count, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`
  ).run(target, origin, tool_name ?? '', input_text, output_text, token_count, now)

  process.exit(0)
}

main().catch((err) => {
  process.stderr.write(`[detail-capture] error: ${err.message}\n`)
  process.exit(1)
})
