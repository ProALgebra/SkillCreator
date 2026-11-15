# Installation verification

Date: November 14, 2026. These checks used a user installation of OpenCode **2.3.0** through its existing local background service. This is a historical verification record; the latest installed build recorded here is **0.3.1**.

## Recorded installation

- Installed build: `~/.local/share/opencode/skill-curator-runtime/releases/0.3.1-a15497222b92`.
- Server configuration: `~/.config/opencode/opencode.jsonc`. The original was backed up beside it as `opencode.jsonc.skill-curator-backup-20261114T140738Z`.
- Local TUI configuration: `~/.config/opencode/cli.json`. Created to supply manager options because SDK 2.3 server inventory passes the package path without options.
- Both configurations load the same package with `options.local_service_auth: true`. Authorization is derived from private local OpenCode credentials; no additional secrets are written to disk. npm dependencies live in the adjacent `runtime/node_modules` directory and are available to each versioned build through standard module resolution.
- The service reloaded configuration with `opencode reload`. The installed build is separate from source, so rebuilding the project does not replace the running plugin. The version directory lives outside `node_modules`: OpenCode 2.3 caches transitive imports inside `node_modules` and does not replace them on ordinary reload. Watcher registration for all plugin modules was confirmed in the releases directory.

## Initial 0.1.0 results

| Check         | Result                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loading       | Plugin inventory: `opencode-skill-curator`, active, server/tui/rpc                                                                               |
| Storage       | `system.health`: healthy, SQLite/WAL, native `bun:sqlite`                                                                                        |
| Authorization | Requests without a capability or with another tenant were rejected                                                                               |
| Skills        | Create, read, search, archive/restore, and visibility in native OpenCode `skill.list` passed without restart                                     |
| TUI           | `/skills-manager` opened in the real client; the temporary `curator-ui-check` skill appeared, its row was selected, and its action dialog opened |
| Direct        | DeepSeek `deepseek-flash`: job `ea429443-fd1d-4f23-8929-f62e9fd2c206`, completed                                                                 |
| Session       | Same model: job `5f63bb87-d621-4591-8090-ef57d23e442c`, completed; a separate internal session was created                                       |
| Publication   | `executors.test` created no proposals and made no changes to working skills                                                                      |

The original base model, `opencode/iceman-free`, returned an explicit `ProviderRequestError`, `rate_limit`, HTTP 429: its free quota was exhausted. The positive check used the user's already configured DeepSeek provider. OpenCode model settings were not changed.

Fixes made during verification covered TUI location forwarding, serialization of nested optional RPC fields into `JsonValue`, catalog error display, shortcut scope, menu layout in narrow terminals, forwarding the interface's selected model, and failing jobs after explicit provider rejection. Ambiguous network outcomes retain their reservation and require reconciliation; no fallback occurs after acceptance.

## Publication switch in 0.2.1

Build `0.2.1-b0438569a32f` was installed in the server and CLI; `system.health` confirmed the new version and healthy status. The live service verified `settings.set_publication_mode`: dry-run without a revision change, `mode=auto` with both create/patch permissions, idempotent replay, and return to `mode=manual`. After testing, the original policy was restored: manual, `allow_auto_create=false`, `allow_auto_patch_managed_low_risk=false` (workspace revision 2). To enable automatic publication, choose `/skills-publication` → **Automatic**, or use the corresponding `/skills-settings` entry.

Final checks passed: 102 Node tests, typecheck/build, Bun SQLite, headless OpenTUI covering enable/disable, cancellation, no-op, conflicts/errors, location, and JSON settings, plus npm package exports. In the real TUI, `/skills-publication` was found through autocomplete and opened the skill publication dialog with manual and automatic choices. Switching modes does not publish existing pending proposals. Automatic creation, automatic updating, and return to pending were checked through the complete core chain with a controlled executor.

## Repeating the basic check

From the source project, using Node.js 22.21.1+:

```bash
npm run test:live
npm run test:live -- --model --provider deepseek --model-id deepseek-flash
```

The second command calls the configured provider. The check creates only a temporary skill and archives it in `finally`, preserving the audit history. Substitute your own model if needed. For a manual check, open OpenCode in the desired project and run `/skills-manager`.

## Conversation review in 0.2.0

Added `learning.sessions`, `learning.refine`, and `/skills-refine`. In the real TUI, autocomplete found the command and opened the past-conversation selector. Checks covered access to archived records, preview without publication, and inheritance of the source session's model.

- Direct: job `3de2dd0a-70ed-4314-b981-e5087188c560`, completed; created one pending proposal with a quote and snapshot reference.
- Session: job `ef8cc0e4-26fd-4ac7-97f5-62408c20b214`, completed; a candidate with confidence 0.55 produced no proposal, consistent with the 0.7 threshold.
- Final build after the JSON quote fix: session job `59a6a509-0ab8-4976-adf2-934a89213cb6`, completed; history, preview, and model selection were verified. Health was healthy, `conversation_review.enabled=true`, threshold 10, manual approval, and `allow_auto_create=false`.
- Used the already configured DeepSeek `deepseek-flash`. Test conversations were archived and pending proposals canceled; this check published no skills. No unfinished jobs remained.
- The automatic trigger was checked by an integration test using the real one-second scheduler with an SDK double: a failed read and a successful edit both count as actions, analysis waits for successful response completion, internal sessions are excluded, and model/source selection is forwarded. A separate live conversation with 10 real tool actions was not generated in the user service.

Repeat manual review through the SDK:

```bash
npm run test:refine:live -- --provider deepseek --model-id deepseek-flash
npm run test:refine:live -- --mode session
```

Both commands call the provider and require manual approval in the workspace. The model may find no sufficiently reliable knowledge; `--require-proposal` additionally requires at least one proposal. Test conversations are archived and proposals canceled. Audit records remain.

Automated 0.2.0 checks passed: 94 Node tests, TypeScript/build, Bun native SQLite, headless OpenTUI covering both location-selection paths, current/historical `/skills-refine`, and error display, plus formatting and exports from an extracted npm package. VALERIA and remote deployment were outside this live check.

## Automatic curator in 0.3.0

Build `0.3.0-bc62fd43cf31` was installed in the server and CLI. The service reread both configurations through `opencode reload`. Source-project checks passed: **144 Node tests**, typecheck/build, Bun native SQLite, headless OpenTUI, and exports from an extracted npm package.

Headless TUI tests covered `/skills-optimize`: running with the selected model, preview without a model call, reports, schedule, pause/resume, and rollback preparation. **Automatic review** switches between **Disabled**, **Check for stale skills**, and **Semantic optimization**. Schedule and other parameters can be changed separately. Automatic merging has its own permission; applying a merge automatically requires both `approval.mode=auto` and `approval.allow_auto_merge=true`.

In the real native TUI, autocomplete found `/skills-optimize` and opened the skill-library optimization dialog with run, preview, status, automatic review, schedule, and automatic merge controls. Basic `test:live` also passed: native `skill.list` visibility, archive/restore, and authorization.

A live check used actual OpenCode RPC with the already configured DeepSeek `deepseek-flash`, in `direct` mode with manual publication:

- Job `17b240f3-2790-460e-b9e2-cd53d9571622` completed and created one proposal to merge two temporary duplicate skills.
- The proposal was approved and applied: a coherent `SKILL.md` was created, shorter than the combined source instructions; supporting resources were preserved byte for byte, and both sources became `superseded`.
- `curator.rollback` created a separate pending proposal. After explicit approval and application, both complete original packages were restored.
- The curator report was available through `curator.status`. All three temporary skills were archived after testing; versions and audit records remain.

The service ended the check with `system.health` reporting **0.3.0, healthy, bun:sqlite**; manual publication, `allow_auto_merge=false`, `llm_review_enabled=false`, and no unfinished jobs. The schedule was initialized and two curator reports were stored. `format:check` passed. To enable background semantic review, select `/skills-optimize` → **Automatic review** → **Semantic optimization**; configure publication policy and automatic merge permission separately.

The live service was not left waiting for the default **168-hour** background interval. Scheduling, persisted state after restart, idle checks, pauses, budgets, deduplication, and unfinished-job handling were covered by automated tests. The live call above verifies manual execution of the same optimizer. Size checks and source quotes do not prove semantic equivalence of merged instructions; manual approval remains the default.

Repeat the live check from the project:

```bash
npm run test:optimizer:live -- --require-merge
```

This command calls the provider and requires manual publication mode. Defaults are `direct` and `deepseek/deepseek-flash`; replace the provider/model with `--provider` and `--model-id`. It creates two temporary skills and checks preview, merging, resource preservation, approved rollback, and reporting. Temporary skills are archived in `finally`; audit records remain. The model may legitimately leave skills unchanged; `--require-merge` makes a merge proposal necessary for this check to pass.

## Skill selection and built-in sources in 0.3.1

Build `0.3.1-a15497222b92` was installed in the server and CLI, followed by `opencode reload`. The empty catalog was caused by built-in OpenCode skills with capitalized names, virtual `skill://` paths, and contents without YAML front matter. Discovery no longer validates these API snapshots as newly created packages: it stores redacted text for readonly/incomplete_source viewing. Complete packages still require strict validation; incomplete snapshots cannot be cloned, modified, or optimized automatically.

Live RPC checks in the user's home directory (`~`) and the project confirmed **Browser, OpenCode, Report**, healthy 0.3.1, and stable revisions after repeated synchronization. In the real native TUI, `/skills-manager` showed three skills; the down arrow selected OpenCode and Enter opened its actions. Searching for `collect standard diagnostics` left Report; the first Enter moved focus from search to the result and the second opened `Report · revision 1`. Headless OpenTUI also checked real mouse clicks, text input, the current revision after editing, removal of the selected entry, empty tabs, viewer mode, and scrolling through a long catalog.

**147 Node tests** passed, along with TypeScript/build, Bun native SQLite, headless OpenTUI, `format:check`, and npm package checks. The basic live authorization and create/visibility/archive/restore check also passed; its temporary skill was archived. To load an updated TUI build, restart an already open OpenCode client and open `/skills-manager` again. Use ↑/↓ or the mouse to select, Enter for actions, Ctrl+F/Tab for search, and Ctrl+R to synchronize sources.

## Complete context analysis — source verification, November 15, 2026

The repository and freshly packed npm archive passed **199 Node tests**, TypeScript/build, Bun native SQLite, headless OpenTUI, formatting, and exports/SQLite initialization from an extracted package. New checks cover complete source coverage, bounded extraction and reduction, late corrections reaching final reconciliation, exact evidence, frozen verified-record batches, shared cost/call limits, retries/restarts, pause/cancel, and a final result retained during pause without another provider call on resume. Fault injection covers atomic worker preflight and committed publication-journal cleanup failures.

These checks use local executor and SDK test doubles. No new paid provider call or installed-plugin replacement was performed for this workflow. The installed 0.3.1 release and earlier live reports above remain separate from these source checks. See [context analysis](CONTEXT_ANALYSIS.md) for configuration and limitations.

## Automatic defaults and disabled monetary limits — source verification, November 15, 2026

The source and freshly packed npm archive passed **222 Node tests**, TypeScript/build, Bun native SQLite, headless OpenTUI, formatting and package export checks. Fresh-default tests verify automatic skill creation, eligible refinement and semantic merging without approval, plus scheduled semantic analysis. Cost tests verify null monetary allowances, optional finite/zero limits, retained liabilities, explicit unknown-cost markers and RPC completion with partial usage. The context budget remains **45,000 tokens** and keeps its bounded analysis checks.

Existing saved settings are preserved. No installed-plugin replacement or paid provider call was performed; the SDK executor checks use local test doubles.
