// Keep tests hermetic when they are run from inside a live Codex session.
// Individual tests that need these values set them explicitly in child env.
delete process.env.THROUGHLINE_CODEX_THREAD_ID;
delete process.env.CODEX_THREAD_ID;
