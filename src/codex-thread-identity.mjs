export function resolveCodexThreadIdentity({ codexThreadId = null } = {}, env = process.env) {
  if (codexThreadId) {
    return {
      codexThreadId,
      codexThreadIdSource: 'arg:--codex-thread-id',
    };
  }

  for (const name of ['THROUGHLINE_CODEX_THREAD_ID', 'CODEX_THREAD_ID']) {
    const value = typeof env[name] === 'string' ? env[name].trim() : '';
    if (value) {
      return {
        codexThreadId: value,
        codexThreadIdSource: `env:${name}`,
      };
    }
  }

  return {
    codexThreadId: null,
    codexThreadIdSource: null,
  };
}
