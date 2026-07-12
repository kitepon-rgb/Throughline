import { observeRuntimeError } from './runtime-error-store.mjs';

try {
  const result = observeRuntimeError({ code: process.argv[2] });
  process.exitCode = result.status === 'disabled' ? 3 : 0;
} catch {
  process.exitCode = 1;
}
