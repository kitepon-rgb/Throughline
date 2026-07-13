// Keep tests hermetic when they are run from inside a live Codex session.
// Individual tests that need these values set them explicitly in child env.
delete process.env.THROUGHLINE_CODEX_THREAD_ID;
delete process.env.CODEX_THREAD_ID;

// node:sqlite emits an ExperimentalWarning on Node 22.  Several CLI tests
// intentionally assert their child process stderr contract, so suppress the
// runtime warning for test children without changing production stderr.
process.env.NODE_NO_WARNINGS = '1';

// Windows cannot execute the POSIX shebang used by the ephemeral fake Codex
// app-server fixtures.  Run their .mjs bodies with this test runner's Node
// executable, preserving the command arguments the production code sends.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const { spawn: nativeSpawn, spawnSync: nativeSpawnSync } = childProcess;

function normalizeNodeFixture(command, args = []) {
  if (process.platform === 'win32' && typeof command === 'string' && command.endsWith('.mjs')) {
    return [process.execPath, [command, ...args]];
  }
  return [command, args];
}

childProcess.spawn = function spawn(command, args, options) {
  const [normalizedCommand, normalizedArgs] = normalizeNodeFixture(command, args);
  return nativeSpawn(normalizedCommand, normalizedArgs, options);
};

childProcess.spawnSync = function spawnSync(command, args, options) {
  const [normalizedCommand, normalizedArgs] = normalizeNodeFixture(command, args);
  return nativeSpawnSync(normalizedCommand, normalizedArgs, options);
};

syncBuiltinESMExports();
