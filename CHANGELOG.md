# Changelog

Changes are listed by version. These entries describe repository versions; they do not imply publication to the npm registry.

## Unreleased

### Added

- Complete redacted conversation snapshots with bounded part extraction, chronological reconciliation, durable progress, pause/resume and shared analysis cost/call limits.
- Frozen verified-record batches with exact evidence references, sequential continuation and aggregate job status.
- Configurable `analysis.max_calls` and `analysis.overlap_chars`, with input budgets reserving space for model output and request overhead.

### Fixed

- Validate external-worker context before accepting a lease, so failed preflight cannot strand a running job or reservation.
- Preserve committed skill files when publication-journal cleanup fails, and reconcile pending journals before later publication.
- Keep omitted Learner sources unprocessed and reject evidence from a different stage sharing the same conversation alias.

### Changed

- Expand verified-learning, conversation-refinement, and semantic-optimizer prompts using Hermes-inspired task-class organization, actionable procedures, scoped preferences, and lesson deduplication.
- Align instructions with append-only refinements, bounded catalog visibility, literal evidence, and server-preserved resources. See [prompt design](docs/PROMPTS.md).

## 0.3.2 — 2026-11-14

### Changed

- Translate the terminal interface, prompts, notifications, and live-check fixtures into English, with matching UI assertions.
- Translate technical documentation and the implementation history into English.
- Move the original requirements to `docs/SPECIFICATION.md` and update references.
- Restructure the README around installation, commands, defaults, and integration; add contributor guidance and release notes.

## 0.3.1 — 2026-11-14

### Fixed

- Display built-in OpenCode skills with virtual `skill://` paths, display names, and body-only content as redacted read-only previews.
- Support mouse and keyboard selection, search focus, empty states, and scrolling in the skill manager.
- Refresh the selected skill's revision before opening actions and synchronize sources when opening the manager or pressing Ctrl+R.

## 0.3.0 — 2026-11-14

### Added

- Durable curator scheduling with idle checks, pauses, budget handling, and continuation through large catalogs.
- Semantic keep/patch/merge/archive plans with source coverage, immutable proposals, complete resource preservation, and rollback proposals.
- `/skills-optimize`, optimization reports, schedule controls, and separate automatic-merge permission.

### Fixed

- Account for queued job reservations when checking daily budgets.
- Detect name conflicts with both active and stale skills.
- Preserve logical package hashes for byte-identical resources represented as base64.

## 0.2.1 — 2026-11-14

### Added

- `settings.set_publication_mode` and `/skills-publication` for manual or automatic creation and eligible managed-skill updates.

## 0.2.0 — 2026-11-14

### Added

- Full conversation review, current/history selection through `/skills-refine`, and automatic review after a configured action threshold.
- Source snapshots, literal evidence validation, model inheritance, and separate automatic-creation permission.

## 0.1.0 — 2026-11-14

### Added

- OpenCode server/TUI/RPC plugin with a durable SQLite catalog, complete skill packages, versioning, proposals, and approval controls.
- Learning, review, merge/split, archive/restore, worker routing, leases, budgets, audit, and recovery.
- TypeScript/Python integration examples, documentation, and CI.
