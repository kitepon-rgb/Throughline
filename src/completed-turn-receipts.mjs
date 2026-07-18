import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import childProcess from 'node:child_process';
import { homedir, platform as hostPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashAuditorBody } from './body-digest.mjs';
import { normalizeProjectPathForCompare } from './project-path.mjs';

export const COMPLETED_TURN_RECEIPT_STORE_SCHEMA = 'throughline.completed_turn_receipts.v1';
export const COMPLETED_TURN_RECEIPT_SCHEMA_VERSION = '1.0';
export const COMPLETED_TURN_RECEIPT_LIMIT = 256;

const PRIVATE_DIRECTORY_CAPABILITY = Symbol('throughline.completed-turn-receipt-directory');
// CI実測でPowerShellコールドスタートが3.0〜3.2秒に達しflakeしたため15秒 (run 29586852389 / 29628634501)
const WINDOWS_ACL_TIMEOUT_MS = 15_000;

export function defaultCompletedTurnReceiptStorePath(projectSha256, env = process.env) {
  if (!isSha256(projectSha256)) throw new TypeError('projectSha256 must be a SHA-256 digest');
  const home = env.HOME || env.USERPROFILE || homedir();
  if (isWindows(env)) {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'throughline', 'completed-turn-receipts', `${projectSha256}.json`);
  }
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'throughline', 'completed-turn-receipts', `${projectSha256}.json`);
}

/**
 * Captures one Claude Stop completion after its L2 user/assistant pair is durable in SQLite.
 * The pair identity is immutable: a Stop retry returns the original receipt and never consumes
 * another sequence number.
 */
export function writeCompletedTurnReceipt(input, options = {}) {
  assertExactInput(input);
  assertExactOptions(options);
  const normalized = normalizeInput(input);
  return withStoreLock(normalized, options, (privateDirectory) => {
    const store = readStore(normalized, options, privateDirectory);
    const existing = store.receipts.find((receipt) => samePair(receipt, normalized));
    if (existing) return { ...existing };

    const receipt = {
      schema_version: COMPLETED_TURN_RECEIPT_SCHEMA_VERSION,
      host: 'claude',
      project_sha256: normalized.projectSha256,
      target_session_id: normalized.targetSessionId,
      origin_session_id: normalized.originSessionId,
      user_sha256: normalized.userSha256,
      assistant_sha256: normalized.assistantSha256,
      completed_at: normalized.completedAt,
      sequence: store.next_sequence,
    };
    store.next_sequence += 1;
    store.receipts.push(receipt);
    if (store.receipts.length > COMPLETED_TURN_RECEIPT_LIMIT) {
      store.receipts.splice(0, store.receipts.length - COMPLETED_TURN_RECEIPT_LIMIT);
      store.history_floor = store.receipts[0].sequence;
    }
    writeStore(store, normalized, options, privateDirectory);
    return { ...receipt };
  });
}

/** Read-only receipt snapshot. This never creates a directory, lock, or store file. */
export function readCompletedTurnReceiptSnapshot(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some((key) => !['projectPath', 'env', 'storePath'].includes(key))) {
    throw new TypeError('completed turn receipt snapshot options are invalid');
  }
  const { projectPath, env = process.env, storePath } = input;
  const projectSha256 = sha256(normalizeProjectPathForCompare(assertProjectPath(projectPath)));
  const options = { env, storePath };
  const path = storePathFor({ projectSha256 }, options);
  try {
    const info = lstatSync(path);
    assertPrivateFile(info, env, path);
    assertPrivateDirectory(dirname(path), env);
    const store = JSON.parse(readFileSync(path, 'utf8'));
    validateStore(store, projectSha256);
    return cloneStore(store);
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore(projectSha256);
    throw error;
  }
}

function normalizeInput(input) {
  return {
    projectSha256: sha256(normalizeProjectPathForCompare(assertProjectPath(input.projectPath))),
    targetSessionId: normalizeIdentity(input.targetSessionId, 'targetSessionId'),
    originSessionId: normalizeIdentity(input.originSessionId, 'originSessionId'),
    userSha256: hashAuditorBody(assertBody(input.userBody)),
    assistantSha256: hashAuditorBody(assertBody(input.assistantBody)),
    completedAt: normalizeCompletionTimestamp(input.completedAt),
  };
}

function emptyStore(projectSha256) {
  return {
    schema: COMPLETED_TURN_RECEIPT_STORE_SCHEMA,
    project_sha256: projectSha256,
    next_sequence: 1,
    history_floor: 1,
    receipts: [],
  };
}

function readStore(normalized, options, privateDirectory) {
  const path = storePathFor(normalized, options);
  try {
    const info = lstatSync(path);
    assertPrivateFile(info, options.env, path);
    assertPrivateDirectoryCapability(privateDirectory, dirname(path), options.env);
    const store = JSON.parse(readFileSync(path, 'utf8'));
    validateStore(store, normalized.projectSha256);
    return store;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore(normalized.projectSha256);
    throw error;
  }
}

function writeStore(store, normalized, options, privateDirectory) {
  validateStore(store, normalized.projectSha256);
  const path = storePathFor(normalized, options);
  const directory = dirname(path);
  assertPrivateDirectoryCapability(privateDirectory, directory, options.env);
  const temporary = join(directory, `.completed-turn-receipts.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(store)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (isWindows(options.env)) {
      applyAndVerifyWindowsAcl(temporary, false);
      assertPrivateFileShape(lstatSync(temporary));
    } else {
      chmodSync(temporary, 0o600);
    }
    renameSync(temporary, path);
    assertPrivateFile(lstatSync(path), options.env, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function withStoreLock(normalized, options, operation) {
  const storePath = storePathFor(normalized, options);
  const directory = dirname(storePath);
  ensurePrivateDirectory(directory, options.env);
  const lockPath = `${storePath}.lock.sqlite`;
  let created = false;
  try {
    writeFileSync(lockPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (created) {
    if (isWindows(options.env)) applyAndVerifyWindowsAcl(lockPath, false);
    else chmodSync(lockPath, 0o600);
  }
  assertPrivateFile(lstatSync(lockPath), options.env, lockPath);
  const database = new DatabaseSync(lockPath);
  let active = false;
  try {
    database.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    active = true;
    const result = operation(privateDirectoryCapability(directory, options.env));
    database.exec('COMMIT');
    active = false;
    return result;
  } finally {
    if (active) { try { database.exec('ROLLBACK'); } catch {} }
    database.close();
  }
}

function ensurePrivateDirectory(directory, env) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  assertPrivateDirectoryShape(info);
  if (isWindows(env)) applyAndVerifyWindowsAcl(directory, true);
  else chmodSync(directory, 0o700);
  assertPrivateDirectory(directory, env);
}

function privateDirectoryCapability(directory, env) {
  return Object.freeze({ directory, windows: isWindows(env), [PRIVATE_DIRECTORY_CAPABILITY]: true });
}

function assertPrivateDirectoryCapability(capability, directory, env) {
  if (!capability || capability[PRIVATE_DIRECTORY_CAPABILITY] !== true ||
    capability.directory !== directory || capability.windows !== isWindows(env)) {
    assertPrivateDirectory(directory, env);
    return;
  }
  assertPrivateDirectoryShape(lstatSync(directory));
}

function assertPrivateDirectory(directory, env) {
  const info = lstatSync(directory);
  assertPrivateDirectoryShape(info);
  if (isWindows(env)) verifyWindowsAcl(directory, true);
  else assertPosixOwnerMode(info, 0o700);
}

function assertPrivateFile(info, env, path) {
  assertPrivateFileShape(info);
  if (isWindows(env)) verifyWindowsAcl(path, false);
  else assertPosixOwnerMode(info, 0o600);
}

function assertPrivateDirectoryShape(info) {
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('completed turn receipt directory unsafe');
}

function assertPrivateFileShape(info) {
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('completed turn receipt store path unsafe');
}

function assertPosixOwnerMode(info, expectedMode) {
  if ((info.mode & 0o777) !== expectedMode) throw new Error('completed turn receipt permissions unsafe');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('completed turn receipt owner unsafe');
  }
}

function validateStore(store, expectedProjectSha256) {
  if (!store || typeof store !== 'object' || Array.isArray(store) ||
    !exactKeys(store, ['schema', 'project_sha256', 'next_sequence', 'history_floor', 'receipts']) ||
    store.schema !== COMPLETED_TURN_RECEIPT_STORE_SCHEMA ||
    store.project_sha256 !== expectedProjectSha256 || !isSha256(store.project_sha256) ||
    !Number.isSafeInteger(store.next_sequence) || store.next_sequence < 1 ||
    !Number.isSafeInteger(store.history_floor) || store.history_floor < 1 || store.history_floor > store.next_sequence ||
    !Array.isArray(store.receipts) || store.receipts.length > COMPLETED_TURN_RECEIPT_LIMIT) {
    throw new Error('completed turn receipt store schema invalid');
  }
  const identities = new Set();
  for (const [index, receipt] of store.receipts.entries()) {
    validateReceipt(receipt, store.next_sequence);
    const identity = receiptIdentity(receipt);
    if (identities.has(identity) || receipt.project_sha256 !== store.project_sha256 ||
      receipt.sequence !== store.history_floor + index) {
      throw new Error('completed turn receipt uniqueness invalid');
    }
    identities.add(identity);
  }
  if (store.receipts.length > 0 && store.history_floor !== store.receipts[0].sequence) {
    throw new Error('completed turn receipt history floor invalid');
  }
  if (store.receipts.length === 0 && store.history_floor !== store.next_sequence) {
    throw new Error('completed turn receipt history floor invalid');
  }
  if (store.receipts.length > 0 && store.next_sequence !== store.history_floor + store.receipts.length) {
    throw new Error('completed turn receipt sequence continuity invalid');
  }
}

function validateReceipt(receipt, nextSequence) {
  const keys = [
    'schema_version', 'host', 'project_sha256', 'target_session_id', 'origin_session_id',
    'user_sha256', 'assistant_sha256', 'completed_at', 'sequence',
  ];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
    !exactKeys(receipt, keys) || receipt.schema_version !== COMPLETED_TURN_RECEIPT_SCHEMA_VERSION ||
    receipt.host !== 'claude' || !isSha256(receipt.project_sha256) ||
    !isIdentity(receipt.target_session_id) || !isIdentity(receipt.origin_session_id) ||
    !isSha256(receipt.user_sha256) || !isSha256(receipt.assistant_sha256) ||
    !Number.isSafeInteger(receipt.completed_at) || receipt.completed_at < 0 ||
    !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1 || receipt.sequence >= nextSequence) {
    throw new Error('completed turn receipt value invalid');
  }
}

function samePair(receipt, input) {
  return receipt.project_sha256 === input.projectSha256 &&
    receipt.origin_session_id === input.originSessionId &&
    receipt.user_sha256 === input.userSha256 &&
    receipt.assistant_sha256 === input.assistantSha256;
}

function receiptIdentity(receipt) {
  return [receipt.project_sha256, receipt.origin_session_id,
    receipt.user_sha256, receipt.assistant_sha256].join('\0');
}

function assertBody(value) {
  if (typeof value !== 'string') throw new TypeError('receipt body must be a string');
  return value;
}

function normalizeIdentity(value, name) {
  if (!isIdentity(value)) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function normalizeCompletionTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('completedAt must be a non-negative integer');
  return value;
}

function assertProjectPath(value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('projectPath must be a non-empty string');
  return value;
}

function storePathFor(normalized, options) {
  return options.storePath || defaultCompletedTurnReceiptStorePath(normalized.projectSha256, options.env);
}

function cloneStore(store) {
  return {
    schema: store.schema,
    project_sha256: store.project_sha256,
    next_sequence: store.next_sequence,
    history_floor: store.history_floor,
    receipts: store.receipts.map((receipt) => ({ ...receipt })),
  };
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isSha256(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function isIdentity(value) { return typeof value === 'string' && value.length > 0 && value.length <= 4096; }
function exactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}
function assertExactInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    !exactKeys(input, ['projectPath', 'targetSessionId', 'originSessionId', 'userBody', 'assistantBody', 'completedAt'])) {
    throw new TypeError('completed turn receipt input is invalid');
  }
}
function assertExactOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
    Object.keys(options).some((key) => !['env', 'storePath'].includes(key))) {
    throw new TypeError('completed turn receipt options are invalid');
  }
}
function isWindows(env = process.env) { return env.OS === 'Windows_NT' || hostPlatform() === 'win32'; }

function applyAndVerifyWindowsAcl(path, directory) { runWindowsAclScript(path, directory, WINDOWS_ACL_APPLY_SCRIPT); }
function verifyWindowsAcl(path, directory) { runWindowsAclScript(path, directory, WINDOWS_ACL_VERIFY_SCRIPT); }
function runWindowsAclScript(path, directory, script) {
  const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, THROUGHLINE_ACL_PATH: path, THROUGHLINE_ACL_DIRECTORY: directory ? '1' : '0' },
    stdio: 'ignore', timeout: WINDOWS_ACL_TIMEOUT_MS, windowsHide: true,
  });
  if (result.status !== 0) throw new Error('Windows owner-only ACL verification failed');
}

const WINDOWS_ACL_VERIFY_SCRIPT = String.raw`
$p=$env:THROUGHLINE_ACL_PATH; $isDir=$env:THROUGHLINE_ACL_DIRECTORY -eq '1'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl=if($isDir){[System.IO.Directory]::GetAccessControl($p)}else{[System.IO.File]::GetAccessControl($p)}
$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if($owner -ne $sid){exit 41}; $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); if($rules.Count -ne 1){exit 42}
$r=$rules[0]; if($r.IdentityReference.Value -ne $sid -or $r.AccessControlType -ne 'Allow' -or $r.IsInherited -or ($r.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl){exit 43}
`;

const WINDOWS_ACL_APPLY_SCRIPT = String.raw`
$p=$env:THROUGHLINE_ACL_PATH; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$isDir=$env:THROUGHLINE_ACL_DIRECTORY -eq '1'; $acl=if($isDir){New-Object System.Security.AccessControl.DirectorySecurity}else{New-Object System.Security.AccessControl.FileSecurity}; $acl.SetAccessRuleProtection($true,$false)
$flags=if($isDir){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None}
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$flags,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
$acl.SetOwner($sid); $acl.AddAccessRule($rule); if($isDir){[System.IO.Directory]::SetAccessControl($p,$acl)}else{[System.IO.File]::SetAccessControl($p,$acl)}
` + WINDOWS_ACL_VERIFY_SCRIPT;
