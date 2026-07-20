import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  COMPLETED_TURN_RECEIPT_LIMIT,
  defaultCompletedTurnReceiptStorePath,
  writeCompletedTurnReceipt,
} from './completed-turn-receipts.mjs';

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Seeds a schema-valid receipt store without repeating the Windows ACL subprocess path.
 * One public mutation creates the private directory, lock, and store; direct replacement
 * preserves that file ACL, and the caller still performs the boundary mutation publicly.
 */
export function seedCompletedTurnReceiptStore({
  projectPath,
  receiptOptions = {},
  size = COMPLETED_TURN_RECEIPT_LIMIT,
  targetSessionId = 'fixture-target',
}) {
  if (!Number.isSafeInteger(size) || size < 1 || size > COMPLETED_TURN_RECEIPT_LIMIT) {
    throw new TypeError('fixture receipt size is invalid');
  }
  const first = writeCompletedTurnReceipt({
    projectPath,
    targetSessionId,
    originSessionId: 'fixture-origin-1',
    userBody: 'fixture-user-1',
    assistantBody: 'fixture-assistant-1',
    completedAt: 1,
  }, receiptOptions);
  const storePath = receiptOptions.storePath ||
    defaultCompletedTurnReceiptStorePath(first.project_sha256, receiptOptions.env);
  const store = JSON.parse(readFileSync(storePath, 'utf8'));
  store.next_sequence = size + 1;
  store.history_floor = 1;
  store.receipts = Array.from({ length: size }, (_, offset) => {
    const sequence = offset + 1;
    return {
      ...first,
      target_session_id: targetSessionId,
      origin_session_id: `fixture-origin-${sequence}`,
      user_sha256: sha256(`fixture-user-${sequence}`),
      assistant_sha256: sha256(`fixture-assistant-${sequence}`),
      completed_at: sequence,
      sequence,
    };
  });
  writeFileSync(storePath, `${JSON.stringify(store)}\n`, 'utf8');
  return { storePath, projectSha256: first.project_sha256 };
}
