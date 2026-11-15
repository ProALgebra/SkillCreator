# OpenCode Skill Curator implementation plan

Requirements: [original specification](docs/SPECIFICATION.md). This plan was created before implementation.
Statuses: `[ ] pending`, `[-] in progress`, `[x] completed`. Tasks are marked complete after their results have been verified.

1. [x] Review the specification, inspect the available OpenCode SDK, and define the architecture, compatibility boundaries, and acceptance criteria.
2. [x] Create the TypeScript/npm package, build configuration, public types, and RPC contract.
3. [x] Implement durable transactional storage, migrations, versions, audit records, events, and recovery.
4. [x] Implement the catalog and safe handling of complete skill packages: discovery, CRUD, archive/restore, pin/lock/adopt, export/import, and rollback.
5. [x] Implement immutable proposals, diff/validation/approval/apply, merge/split, and conflict and policy checks.
6. [x] Implement jobs, executor routing, limits, cancellation/retry, durable leases, and the worker API.
7. [x] Implement history capture/import, deduplication, secret redaction, the Learner, and deterministic/LLM curation.
8. [x] Connect tenant/workspace authorization, all RPC methods, idempotency, settings, and observability.
9. [x] Implement the OpenCode adapter, commands, and TUI manager using shared server methods.
10. [x] Document architecture, installation, security, and backup/restore; add configuration examples and TypeScript/Python clients.
11. [x] Add CI and run unit, integration, contract, security, recovery, and end-to-end checks; fix identified issues.
12. [x] Verify the build and npm package contents against the specification; record actual limitations and verification results.

## Installation in OpenCode

13. [x] Locate the installed OpenCode and inspect its version, configuration, and running service. OpenCode 2.3.0 and a local background service were found.
14. [x] Configure persistent local authentication, add the plugin to the user configuration, and verify server loading. Live health RPC confirmed native SQLite and direct/session availability.
15. [x] Verify live RPC calls, test-skill creation/visibility/archiving, the TUI, and an available LLM executor; fix identified issues.
16. [x] Repeat the required checks, update the package and documentation, and record live integration results.

## Initial GitHub publication

17. [x] Connect `git@github.com:ProALgebra/SkillCreator.git`, inspect the existing branch, and preserve repository history. The initial commit and ProALgebra MIT license were retained; the working branch is `master`.
18. [x] Prepare the publication, inspect exclusions and secret handling, and run checks before committing. Formatting, npm contents, portable paths, and local-data exclusions were verified; the original MIT license was preserved.
19. [x] Create a commit, push it to GitHub, and verify that local and remote commits match. Commit `70d8c83` was published to `origin/master`; the remote SHA was confirmed.

## Hermes-style conversation learning

20. [x] Analyze the full available context of a selected conversation: messages, actions, errors, corrections, and outcomes. Preserve redaction and traceable source references. Verified an untrusted immutable snapshot, redaction, and explicit truncation of large contexts.
21. [x] Let the analyzer propose a new skill or update a suitable existing skill while respecting versions and protections. Verified package-resource preservation, captured revision/hash checks, and manual/readonly/locked/pinned protection.
22. [x] Add automatic analysis after a completed reply and a configured number of actions. Exclude duplicates, internal sessions, and incomplete replies. The threshold is 10 actions per conversation; restart, interruption, idle, backoff, and uncertain outcomes were checked.
23. [x] Add `/skills-refine` for the current or a selected past conversation, passing the selected model. Headless OpenTUI verifies current/history selection, cancellation, errors, location, and model routing.
24. [x] Add separate permission for automatic publication of new skills while keeping approval as the default. Both `approval.mode=auto` and `allow_auto_create=true` are required.
25. [x] Verify workflows, access boundaries, redaction, deduplication, and automatic triggering; update documentation. All 94 tests, typecheck/build, Bun, OpenTUI, formatting, and npm-package checks passed.
26. [x] Update the installed plugin and verify commands and analysis in real OpenCode. Release `0.2.0-48a202a3be56` was installed for server/CLI; native `/skills-refine` opened history. Direct/session jobs completed; temporary conversations were archived and proposals canceled. Health was healthy, the threshold was 10 actions, publication was manual, and no jobs remained unfinished.

## Publication controls

27. [x] Add a dedicated RPC and a clear manual/automatic publication switch in the TUI. Implemented `settings.set_publication_mode`, `/skills-publication`, and Settings → Skill publication. Automatic mode allows creation and eligible managed-skill updates; disabling it restores manual approval.
28. [x] Verify mode switching, roles, revision/idempotency, automatic publication, and restoration of approval; update documentation and the installed plugin. All 102 tests, build, Bun/OpenTUI, and package checks passed. Release `0.2.1-b0438569a32f` was installed; live RPC verified preview, auto/manual, and replay, and native TUI opened the publication dialog. The original manual policy was restored.
29. [x] Commit conversation review and publication controls after verification. Created `feat: add conversation review and publication mode controls`; all 102 tests and supplementary checks passed.

## Automatic curator and library optimization

30. [x] Connect `curator.llm_review_enabled` to the background scheduler: run after the configured interval during inactivity, persist the latest pass state and timestamps, and respect pauses, budgets, and unfinished jobs.
31. [x] Implement semantic library analysis using descriptions, complete package contents, and usage statistics. Identify overlap and select keep/patch/merge/archive actions; process large libraries in batches within context and budget limits.
32. [x] Implement semantic consolidation into coherent compact instructions: remove repetition, retain useful procedures, applicability conditions, and limitations, and preserve scripts/templates/references/assets with usable relative links.
33. [x] Implement a structured, verifiable optimization plan through immutable proposals. Check scope, rights, revision/hash, lock/pin, dependencies, and package preservation. Applied merges supersede sources while retaining versions, audit records, and recovery.
34. [x] Add separate `allow_auto_merge` permission subject to publication mode. Make passes idempotent, prevent duplicate plans and merges, and retain an independent archival policy.
35. [x] Add curator RPC/TUI controls: `/skills-optimize`, run now, preview without changes, schedule, pause, status, reports, and rollback. Show affected skills and changes in active skill count and library size.
36. [x] Verify the automatic cycle: overlap, instruction preservation, resources and links, protected skills, edit conflicts, restarts, deduplication, model failures, and budget limits. Update documentation and verify packaging and live OpenCode integration. All 144 tests and build/Bun/OpenTUI/package/format checks passed. Version 0.3.0 was installed; a real DeepSeek merge and approved rollback passed, and native `/skills-optimize` opened. Final health was healthy with no unfinished jobs.

## Manager selection fix

37. [x] Reproduce the empty catalog and inspect built-in OpenCode discovery and mouse/keyboard selection. Fix loading and provide a clear empty state.
38. [x] Verify the fix with tests and installed OpenCode; update the build and documentation. All 147 Node tests, build, Bun/OpenTUI, format, and package checks passed. Release `0.3.1-a15497222b92` was installed. Browser/OpenCode/Report appeared in the live catalog; native TUI verified arrow selection, Enter, search, and actions for a filtered skill.

## Snapshot commit

39. [x] Inspect and commit automatic curation, manager fixes, and version 0.3.1 documentation. All 37 files were included; local data and authentication configuration were excluded. Formatting and diff checks passed.

## English documentation and repository presentation

40. [x] Translate all interface labels, messages, live-check fixtures, and matching UI assertions into English without changing behavior.
41. [x] Translate the technical documentation and specification, use consistent terminology, and update documentation links.
42. [x] Rewrite the README for plugin users, translate the task history, and add concise contributor and release documentation.
43. [x] Check the repository for untranslated text, broken local links, formatting errors, and regressions; verify the build and npm package.
44. [x] Commit the complete English-language repository and record the final verification results. The commit includes all 26 changed files, English contribution templates, release notes, and version 0.3.2; formatting and staged diff checks passed.
45. [x] Push the pending commits to `origin/master`, record publication, and verify that the local and remote branches match. Conversation review, automatic curation, manager fixes, and English release 0.3.2 were pushed; the remote SHA was confirmed against local HEAD.

## Complete analysis beyond the context window

46. [x] Plan durable bounded analysis: preserve complete redacted sources, split conversations at message/tool boundaries, record immutable parts and progress, and reserve context for instructions and output. Splitter and budget tests cover complete coverage, Unicode, tool pairs, JSON overhead, and explicit source/part caps.
47. [x] Implement resumable conversation-part analysis and final reconciliation of candidates, including later corrections, exact evidence references, deduplication, relevant skill selection, and a shared cost/call limit. Bounded reductions, parent controls, deferred final results during pause, source coverage, and restart without replay passed.
48. [x] Freeze Learner source manifests, validate evidence against delivered records, and process only completed records while preserving deferred work. Exact manifests, omitted-stage citations, privacy, source changes, sequential continuation and restart/retry checks passed.
49. [x] Prepare external-worker context atomically before accepting a lease; reject invalid context without stranding reservations or blocking valid queued work. Preflight rejection, valid successors, storage rollback and source/privacy/context checks passed.
50. [x] Harden publication recovery so postcommit cleanup failures preserve committed packages and pending recovery prevents newer publications from being overwritten. Injected cleanup, rollback, ambiguous commit, nested transaction and restart failures passed.
51. [x] Verify context limits, partial failures, retries/restarts, corrections, privacy, costs, evidence, lease and publication recovery; update user documentation and mark verified tasks complete. All 199 Node tests, typecheck/build, Bun native SQLite, headless OpenTUI, formatting, and extracted npm package checks passed. No new paid live-model run or installed-plugin update was performed.

## Verification history and design decisions

- The initial working directory contained only the specification, with no implementation, local Git repository, or project conventions.
- SDK versions and supported extension points are inspected before selecting an adapter; unverified APIs are not described as working.
- The package has not been published to npm. The initial GitHub push followed a separate user request after implementation and installation checks.
- The official OpenCode build/plugin documentation for server, CLI, and RPC was checked. Actual `@opencode/plugin@2.3.0` and `@opencode/client@2.3.0` packages were installed; development used Node.js 22.21.1.
- The architecture uses an independent server core, SQLite/WAL, a complete-package publication journal, shared RPC/TUI/worker authorization, and model-generated proposals subject to validation.
- Server, RPC, and Solid/OpenTUI TypeScript builds passed against actual SDK types. SDK 2.3 direct generation returns text only: the built-in adapter consumes the full reserved budget; an external executor can supply exact costs.
- Verified lifecycle, merges with binary assets, approvals, revision/idempotency conflicts, lease/heartbeat/reconciliation, budgets, redaction, and provenance. Crash recovery was tested by interrupting a real child process; the SDK adapter has contract tests.
- SDK 2.3 RPC context lacks an authenticated principal and private live-event filtering. A capability envelope and authorized durable `events.replay` provide access control; private data is not broadcast globally.
- Initial version 0.1.0 passed `npm run check`: typecheck, **57 tests**, and build. HTTP/Python integration, global skills, global/tenant/workspace inheritance, and administrative reconciliation of unknown outcomes were checked.
- Supplementary checks passed: `test:bun` with Bun 1.3.14 for native SQLite lifecycle/restart/backup; real headless OpenTUI catalog/slash-command rendering; `format:check`; and exports/SQLite core from an extracted npm tarball.
- Built `opencode-skill-curator-0.1.0.tgz` with server/tui/rpc exports. Dependencies, databases, tokens, `.env`, and Python caches were excluded. CI includes server, Bun/TUI, and package checks.
- The recorded `npm audit --omit=dev` found no high/critical advisories and 26 moderate transitive advisories in the pinned SDK/OpenTUI. Direct Zod/YAML/diff dependencies were updated.
- A live installation was not checked during the original build. After a separate installation request, OpenCode 2.3.0 was connected and tested for native TUI, RPC, skill lifecycle, and direct/session DeepSeek execution. VALERIA remains verified at the contract level; see [installation checks](docs/INSTALLATION_CHECK.md).
- Initial live release `0.1.0-8d27edfd0f27` configured server/CLI, opened native TUI, and completed direct/session DeepSeek jobs. Explicit HTTP 429 rejection did not block the queue. All 57 tests and package/Bun/TUI checks passed.
- Version 0.2.0 passed 94 tests and supplementary checks; `opencode-skill-curator-0.2.0.tgz` was built and `0.2.0-48a202a3be56` installed. The full report and SDK limitations are in [installation checks](docs/INSTALLATION_CHECK.md).

## Automatic curator 0.3.0 verification

- Passed **144 Node tests**, typecheck/build, Bun native SQLite, headless OpenTUI, and exports from the extracted npm package.
- Verified semantic consolidation and instruction reduction, supporting resources and links, manual/readonly/locked/pinned protection, revision/hash conflicts, idempotency, budgets, failures, and restart recovery. Optimizer dry runs leave all tables and the durable cursor unchanged. Bounded passes continue traversal; oversized packages are reported in `skipped`.
- Verified optimize/rollback authorization, separate tenant/workspace isolation, curator/system pauses, disabling, obsolete revisions, and rejection of rollback without an optimization snapshot. Rollback creates a separate proposal requiring approval.
- Headless OpenTUI covers execution/model/location selection, preview, reports, schedule, pause/resume, rollback preparation, cancellation, and errors. Automatic review offers Disabled / Check for stale skills / Semantic optimization; separate `allow_auto_merge` permission preserves publication mode.
- Release `0.3.0-bc62fd43cf31` was installed for server/CLI and reloaded. Real direct job `17b240f3-2790-460e-b9e2-cd53d9571622` used DeepSeek `deepseek-flash`, completed, and produced an approved merge of two temporary duplicate skills. Compact root instructions, byte-preserved resources, and superseded sources were confirmed; approved rollback restored both complete packages. All three temporary skills were archived and the audit retained.
- Native `/skills-optimize` opened its dialog with run, preview, status, automatic review, schedule, and merging controls. Live native `skill.list`, archive/restore, and authorization checks passed. Final health was healthy 0.3.0 with `bun:sqlite`, manual approval, `allow_auto_merge=false`, `llm_review_enabled=false`, and no unfinished jobs. The schedule was initialized and two curator reports retained; formatting passed.
- The default 168-hour scheduled pass was not awaited in the live service; the scheduler was verified by automated tests. Repeat the controlled live model check with `npm run test:optimizer:live -- --require-merge`; see [installation checks](docs/INSTALLATION_CHECK.md).

## English release 0.3.2 verification

- All tracked interface, documentation, specification, task-history, and live-fixture text is in English. The Cyrillic scan and old-specification-reference check passed.
- All 147 Node tests, typecheck/build, Bun native SQLite, and headless OpenTUI checks passed. English UI assertions cover the same selection, publication, refinement, and optimizer workflows.
- Formatting, local Markdown links, GitHub issue-template parsing, and npm package export checks passed. The archive includes the English specification, changelog, and contributor guide; runtime data and credentials remain excluded.
- Recorded live-installation checks in docs/INSTALLATION_CHECK.md remain explicitly tied to the previously installed releases; this verification concerns the 0.3.2 repository and package.

## Complete context analysis verification — November 15, 2026

- Complete redacted conversations are retained up to the explicit source cap. Bounded message/tool parts cover the original without gaps; additional reductions keep reconciliation within the configured request budget.
- A durable parent coordinates extraction and reconciliation. Only the accepted final result creates proposals and marks the source processed. Pause/resume, cancellation, invalid-part retry, restart, and uncertain worker acceptance were checked; completed parts are retained.
- Legacy verified learning uses canonical record IDs/hashes, exact evidence validation, sequential frozen batches, explicit oversized-record reasons, and shared analysis cost/call limits.
- Lease preflight is atomic with acceptance. Publication recovery preserves committed files and blocks later writes until pending journals can be reconciled.
- Passed all **199 Node tests**, TypeScript/build, Bun native SQLite, headless OpenTUI, formatting, and package exports from the freshly packed npm archive. The new workflow was tested locally with executor/SDK test doubles; installed releases and earlier live reports were not changed.
