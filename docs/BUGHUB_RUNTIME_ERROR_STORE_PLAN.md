# BugHub runtime error store plan

Status: v0.6.2 complete; v0.6.3 Windows bounded-observer hardening in progress

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

### v0.6.3 Windows bounded-observer hardening

- [x] Reproduce the public-CI failure where a cold Windows Node 24 observer
      exceeded the five-second product deadline while starting several
      PowerShell ACL apply/verify processes.
- [x] Characterize the current-SID-only directory, SQLite lock, existing
      store, unique temporary file, atomic replacement, and five-second
      no-fallback contract before changing the implementation.
- [x] Bound one mutation to the minimum distinct ACL transitions: apply plus
      read-back for a private directory and each newly created file, and one
      read-before-use verification for an existing lock/store. Carry a private
      in-process directory capability so unchanged paths are not rechecked by
      another PowerShell process in the same mutation.
- [x] Keep malformed/symlink/ACL-drift state fail-loud, leave no late child or
      partial final store after failure, and do not extend the product deadline.
- [x] Keep the production 3-second ACL and 5-second observer bounds unchanged,
      but serialize Windows CI test files so parallel PowerShell fixture load
      cannot consume those bounds before the contract under test runs.
- [ ] Run focused Windows matrix tests, the complete suite, pack inspection,
      registry-derived smoke, and the public Node 22/24 CI matrix before publish.

## Release wave

- [x] Bump the package and release-facing documentation to `0.6.2` without moving an existing tag.
- [x] Run the full test suite, pack inspection, secret/path scan, and temporary-prefix install smoke.
- [x] Push the release commit and require the public CI gate to pass (`e6ce6e3`, CI `29238704750`).
- [x] After the owner H gate, publish `throughline@0.6.2`, create tag/release, and verify npm `latest` plus a registry-derived isolated install. Global installation is deferred to the dotagents Mac rollout wave.
- [x] Confirm `throughline factory-diagnostics --json` and the runtime-error snapshot from the published package, then record the public SHA and results in the changelog and canonical docs.
