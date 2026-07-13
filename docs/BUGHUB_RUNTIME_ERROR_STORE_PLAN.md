# BugHub runtime error store plan

Status: implementation complete; v0.6.2 release pending

This plan is the implementation TODO for Throughline's product-owned, local
runtime error projection. It implements the cross-repository contract in
`dotagents/docs/plan_bughub-factory-integration.md` without changing the
existing transcript, handoff, or SQLite memory contracts.

## Contract

- Collection is disabled unless the canonical dotagents factory reporter
  config exists and contains the JSON boolean `collection.enabled: true`.
- This module never performs network I/O and never reads
  `reporting.enabled`, endpoints, or credentials.
- Persist only an allow-listed aggregate: product/version, component, stable
  error code, fixed message template, severity, SHA-256 fingerprint, count,
  first/last seen, state schema version, OS/arch, status, and sequence.
- Never accept or persist exception objects, stderr/stdout, stacks, prompts,
  session/transcript bodies, absolute paths, file contents, tokens, cookies,
  arbitrary context, or provider output.
- One failure has one owning observation layer. Existing stderr remains local
  operator diagnostics but is not copied into this store.
- Store failure must not replace the product failure. Emit one fixed diagnostic
  without reflecting the storage error. Observation runs in a bounded child
  process so blocked config/state I/O cannot hold the original hook result.
- Use an owner-private directory/file, atomic replacement, monotonic cursor,
  explicit acknowledgement, explicit resolution/reopen, and retention that
  never removes an unacknowledged record.
- Serialize mutations with a private SQLite `BEGIN IMMEDIATE` mutex. The OS
  releases the lock when a process crashes, so no PID/mtime stale-owner guess
  or application-level reclaim can remove a newer writer's lock.

## TODO

- [x] Add characterization tests for disabled/missing/malformed config.
- [x] Add privacy negative fixtures and stable fingerprint aggregation tests.
- [x] Add acknowledgement, resolution/reopen, retention, mode, and atomic-write tests.
- [x] Implement the product-owned aggregate store and read-only snapshot API.
- [x] Add a machine-readable diagnostics projection without exposing state paths.
- [x] Connect only the top-level hook processing failure boundaries, with fixed
      codes/templates and no duplicate lower-layer observation.
- [x] Run the complete test suite and update product documentation.
- [x] Commit and push this repository independently.

## Release wave

- [x] Bump the package and release-facing documentation to `0.6.2` without moving an existing tag.
- [x] Run the full test suite, pack inspection, secret/path scan, and temporary-prefix install smoke.
- [ ] Push the release commit and require the public CI gate to pass.
- [ ] After the owner H gate, publish `throughline@0.6.2`, create tag/release, and verify npm `latest` plus a registry-derived global install.
- [ ] Confirm `throughline factory-diagnostics --json` and the runtime-error snapshot/ack commands from the published package, then record the public SHA and results in the changelog and canonical docs.
