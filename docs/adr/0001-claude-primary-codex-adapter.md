# ADR 0001: Keep Claude Primary, Add Codex as Adapter

Date: 2026-07-04

## Status

Accepted

## Context

Throughline grew as a Claude Code hooks plugin. Its core behavior depends on Claude-facing hooks, slash commands, transcript parsing, and `/clear` / `/tl` handoff semantics. Codex support is valuable, but replacing Claude contracts would break the existing product boundary and historical guarantees.

## Decision

Keep Claude Code behavior first-class. Add Codex support through adapter/projection layers such as `throughline_handoff`, Codex rollout capture, Codex CLI summarization, and explicit diagnostic trim surfaces. Do not rename, remove, or implicitly replace Claude-facing fields, command names, hook shapes, transcript contracts, or handoff semantics for Codex support.

## Consequences

- Claude hooks and slash commands remain the compatibility baseline.
- Codex support must fail explicitly when required host primitives or captured DB memory are unavailable.
- Agent-neutral core may grow only behind stable Claude-compatible projections.
- Future docs should update the numbered canonical docs before changing README-facing behavior.
