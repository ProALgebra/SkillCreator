# Acceptance and verified limits

This is a local implementation of an npm package. It has not been published to npm. The VALERIA repository and external deployments have not been changed.

## Verified behavior

- TypeScript, declarations, and Solid/OpenTUI build into separate server/tui/rpc exports using SDK 2.3.0.
- Bun 1.3.14: native SQLite lifecycle, restart/restore/backup, and a real headless OpenTUI frame with a catalog and registered slash commands.
- RPC adapter lifecycle with a test double matching real SDK context types: registration, capability checks, skill transformation/reload, and cleanup.
- Create, edit, rename/clone, archive/restore, rollback, pin/lock/adopt, source discovery, and readonly copies.
- Merging with byte-for-byte preservation of binary assets and all source trees; splitting with dependency-loss prevention; proposals with immutable content hashes.
- Concurrent revision conflicts, idempotency replay/conflicts, private scope isolation, and prevention of worker publication.
- Direct/session/auto selection, operation without VALERIA, leases/heartbeats/completion, expired lease reconciliation, timeout without fallback, budgets, and concurrency.
- Verified source → candidate → proposal → approval → version → audit, including deduplication, redaction, and rejection of fabricated evidence.
- Manual/safe/auto policy, manual/readonly/locked/pinned protections, and prevention of archival based solely on `use_count=0`.
- Restart with persisted state/leases and real child-process crashes during publication before/after commit.
- A loopback HTTP bridge and Python client using the same permissions and errors.

Version 0.2.0 adds conversation review: immutable unverified snapshot → candidate → proposal, creation/refinement of skills with policy/revision protection, automatic triggers after actions and response completion, and `/skills-refine` for current/past conversations. Checks cover scope/idle/races, redaction, quotes with embedded quotation marks and newlines, context truncation, restart/deduplication, interruptions, retries, and separate opt-in automatic creation. The SDK scheduler was checked with a real timer and a test SDK context; history access and LLM analysis were also checked in a live user OpenCode installation.

The 0.2.0 run passed 94 unit/integration/security/contract/recovery/end-to-end tests, a separate Bun SQLite smoke test, and a real headless OpenTUI smoke test. Build and exports from an extracted npm tarball also passed.

Version 0.2.1 adds `settings.set_publication_mode` and TUI `/skills-publication`, also available from settings. Checks cover atomic create/patch switching, the complete core auto-create → auto-update → manual-pending chain, no retroactive application, scopes/roles, optimistic revisions, idempotency, dry-run without writes, and settings inheritance. Result: 102 tests passed, along with build, Bun SQLite, and OpenTUI checks.

Version 0.3.0 adds the automatic curator: a durable schedule with idle checks, bounded library batches, a validated LLM keep/patch/merge/archive plan, separate automatic merge permission, and inverse rollback proposals. Checks cover restarts and continuation queues, preservation of complete packages and relative resource trees, protected skills, active/stale name conflicts, revision/hash/disk conflicts, deduplication, unknown outcomes, atomic batch acceptance, and budgets that include queued jobs. `dry_run` does not write to the database. Result: 144 Node tests, typecheck/build, Bun SQLite, and OpenTUI checks passed. Semantic equivalence of compressed instructions is not proven: quotes and structural checks do not replace content evaluation. See [CURATOR.md](CURATOR.md) for controls and limits.

Version 0.3.1 fixes discovery of OpenCode's built-in skills. Virtual API sources without YAML front matter and with display names are retained as redacted readonly snapshots, without permitting publication of incomplete packages. The manager supports mouse and arrow-key selection, refreshes the selected revision, and synchronizes sources on opening and with Ctrl+R. Empty results, search, and loading errors have separate states.

## SDK and environment limits

| Area                 | Implemented behavior / verification limit                                                                                                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live OpenCode        | OpenCode 2.3.0: real service, native TUI, RPC, skill registration, and direct/session execution with configured DeepSeek were checked; results are in [INSTALLATION_CHECK.md](INSTALLATION_CHECK.md)                                                                                                                          |
| Direct usage         | SDK 2.3 `experimental.generate.text` returns text only. The full reservation is charged; this API does not measure the actual provider bill                                                                                                                                                                                   |
| Executor parameters  | Model/provider/variant are passed to the SDK. Its 2.3 Promise adapter ignores `requestOptions.signal`: a direct timeout does not prove generation stopped; session mode also sends an explicit interrupt. Temperature/max_tokens/max_iterations are retained for workers; the native API does not enforce them as hard limits |
| Live events          | The SDK provides no caller identity/ACL for live subscribers. Shared private broadcasts are disabled; `events.replay` is the authorized durable transport                                                                                                                                                                     |
| Running pause        | Queued jobs support pause/resume. Disconnecting an accepted executor is not treated as proof that it stopped; cancellation transitions to unknown until the outcome is confirmed. Unknown local runs are not retried automatically                                                                                            |
| Global skills        | Explicit administrator publication within a tenant; changes originate in the owning workspace. Global catalogs in separate data directories are not synchronized automatically                                                                                                                                                |
| Archive heuristics   | Positive usage observations plus age thresholds. Unknown/zero observability leaves the skill active. Semantic obsolete/duplicate analysis depends on the selected model and the owner                                                                                                                                         |
| Merge scripts        | The complete tree is preserved; scripts assuming a root working directory require manual review. Scripts are not run automatically                                                                                                                                                                                            |
| Settings scope       | Workspace settings inherit tenant and global patches over defaults; a global patch requires a separately server-bound `global_admin`. Revision belongs to the selected layer; `inherited_revisions` exposes parent versions                                                                                                   |
| History access       | Conversation review reads messages/tools available through the SDK; large snapshots are explicitly truncated. Original messages may be absent after compaction. An explicit importer/backfill and the original test-tool evidence mode exist; old archives are not silently scanned                                           |
| Rate limits          | Jobs/context/budget/backlog have limits; a separate distributed HTTP request limiter belongs on the reverse proxy                                                                                                                                                                                                             |
| PII                  | Known formats are filtered heuristically; this does not prove absence of every secret or personal identifier                                                                                                                                                                                                                  |
| Filesystem integrity | File fsync, directory replacement, and journal recovery were tested on a local Linux filesystem; power loss, network filesystems, and hostile processes with the same OS privileges were not modeled                                                                                                                          |
| VALERIA              | RPC/HTTP/Python contracts and pull-worker lifecycle are implemented; VALERIA's own UI and queue were not changed or checked in a live deployment                                                                                                                                                                              |

The live installation check from November 14, 2026 is documented in [INSTALLATION_CHECK.md](INSTALLATION_CHECK.md). Test doubles and invented SDK APIs are not used to conceal other limits. For deployment acceptance, run the scenarios from the [specification](SPECIFICATION.md) against the pinned OpenCode version in your environment.

## Deployment smoke test

1. Configure a capability through the environment or `local_service_auth` in both server/CLI configuration, connect the local package, and open `/skills-manager`.
2. Create a skill and confirm it appears in `ctx.skill.list()`/a new session without restarting.
3. Run a deep review with a configured model in direct and session modes; check that the internal session is separate and does not trigger recursive learning.
4. Check capabilities/manager.snapshot with a VALERIA UI token, then worker lease/heartbeat/complete with a separate worker token.
5. Check restart during a job, a revision conflict after a manual edit, and backup restoration into a new directory.

## Dependencies

Direct Zod/YAML/diff versions were updated to patched releases. On November 14, 2026, `npm audit --omit=dev` reported 0 high/critical issues and 26 moderate transitive advisories from pinned OpenCode 2.3.0 and OpenTUI dependencies. Moving to an incompatible SDK version requires a separate integration run; no forced SDK replacement was performed.

## English repository release 0.3.2

The interface, documentation, original specification, task history, and live-check fixture are written in English. All **147 Node tests**, typecheck/build, Bun native SQLite, headless OpenTUI, formatting, local documentation links, and extracted npm-package checks passed. UI assertions were updated for the English labels, including wrapped empty-state text. These checks do not replace the version-specific live installation records above.
