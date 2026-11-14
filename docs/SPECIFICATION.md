# Technical Specification: OpenCode Skill Curator

**Version:** 1.0  
**Date:** November 13, 2026  
**Status:** original implementation specification  
**Target platform:** OpenCode v2 (`@opencode/plugin`)  
**Integration:** V.A.L.E.R.I.A. (optional, through the RPC API)  
**Deliverable:** a standalone OpenCode npm plugin with a server component, TUI, public RPC contract, documentation, and tests.

> This document preserves the original design requirements. It does not claim that every requirement is implemented. See [Acceptance and implementation status](ACCEPTANCE.md) for current coverage and limitations.

## 1. Purpose

Develop **OpenCode Skill Curator**, a plugin that automatically extracts reusable knowledge from completed OpenCode tasks and conversations, creates and updates skills, reviews the library, merges related skills, identifies and archives outdated skills, and provides a way to inspect and manage the entire library manually.

**Key requirement:** VALERIA must have full programmatic control over the plugin's functions: reading the catalog and history; managing skills; opening the manager and starting reviews; creating and approving changes; changing settings; starting, pausing, and cancelling background jobs; and accessing statistics and events. The plugin **must also work fully without VALERIA**.

**Critical clarification:** internal LLM jobs **do not have to** pass through VALERIA's queue. The user selects the execution mode globally, per operation type, and for each individual run.

## 2. Terminology

- **Skill**: a package containing `SKILL.md` and optionally `scripts/`, `references/`, `templates/`, `assets/`, and other supporting files.
- **Learner**: the subsystem that finds reusable knowledge in completed sessions and tasks.
- **Curator**: the subsystem that reviews, consolidates, updates, and archives skills.
- **Manager**: the shared management subsystem with a TUI and RPC API; it does not have to be a separate LLM session.
- **Proposal**: an immutable proposal to change one or more skills, including a diff, rationale, sources, and risk assessment.
- **Job**: a background task for history analysis, library review, proposal generation, validation, or publication.
- **Executor**: the mechanism that executes the LLM portion of a job.
- **Workspace**: an OpenCode project scope; for VALERIA, it must be associated with an owner or tenant.
- **Managed skill**: a skill that may be maintained automatically under an explicit policy.
- **Adopt**: the explicit transfer of a manually created skill into automatic management.

## 3. Scope and Boundaries

### 3.1. Required

1. Discover all skills available to OpenCode and the managed catalog, including global skills, project skills, and accessible external sources.
2. View a skill's complete contents and associated package, metadata, version history, and usage statistics.
3. Support manual creation, editing, renaming, cloning, merging, archiving, restoration, pinning (`pin`), modification locking (`lock`), adoption into management (`adopt`), export, diff inspection, and version rollback.
4. Automatically collect experience after completed sessions; support batch and retrospective history analysis.
5. Use LLM analysis to assess skill quality: new skills, patches, duplicates, merges, splitting overly broad skills, and outdated instructions.
6. Run periodic deterministic reviews without an LLM and optional in-depth LLM reviews.
7. Provide versioning, lossless archival, safe restoration, and a change log.
8. Provide a TUI manager opened with `/skills-manager`, plus commands for starting common operations quickly.
9. Expose a typed RPC contract to VALERIA and other external clients through the OpenCode server.
10. Provide configurable LLM execution that does not require VALERIA.
11. Isolate workspaces, tenants, and external client permissions.
12. Process transcripts safely, accounting for secrets, private data, prompt injection, and untrusted tool outputs.

### 3.2. Not Required in the First Version

- Training or fine-tuning model weights.
- Automatically publishing skills to public repositories or marketplaces.
- Automatically downloading and executing arbitrary scripts from discovered skills.
- Requiring an external vector database; a local index and heuristic search are acceptable.
- Modifying OpenCode or VALERIA source code for the plugin's basic standalone operation.

## 4. Architecture

```text
OpenCode v2
  ├─ Server Plugin
  │    ├─ Skill Catalog / Package Store
  │    ├─ History Collector + Importer
  │    ├─ Learner + Curator
  │    ├─ Proposal Engine + Validator
  │    ├─ Job Scheduler + Executor Router
  │    ├─ Audit / Usage / Version Store
  │    └─ RPC Server (skill-curator.v1)
  ├─ TUI Plugin
  │    └─ /skills-manager: list / search / diff / settings / jobs
  └─ Optional GUI Plugin (not required for release)

RPC API  <─────────────────────► VALERIA / other clients
                                  ├─ skill manager panel
                                  ├─ administration
                                  └─ optional job executor
```

Management business logic resides **only in the server core**. The TUI, VALERIA, and other clients call the same methods. Separate, incompatible access rules or file handling rules across interfaces are not permitted.

The package exports `./server` (or its main export), `./tui`, and `./rpc`; `./gui-experimental` is optional. Suggested stack: TypeScript, `@opencode/plugin`, `@opencode/client`, JSON Schema/Zod, and SQLite or another transactional local database. The implementation may choose the database library, provided it preserves the API and integrity guarantees.

## 5. Storage Model

### 5.1. Skill Sources and Scopes

Maintain a catalog of available skills with these fields:

- `skill_id`: a stable catalog identifier, distinct from the mutable name;
- `name`, `description`, `scope`: `global | workspace | external`;
- `tenant_id`, `workspace_id` (where applicable), `source`, `source_path`;
- `owner`: `plugin | user | third_party | unknown`;
- `management_policy`: `managed | manual | readonly`;
- `state`: `active | stale | archived | superseded`;
- `pinned`, `locked`, `created_at`, `updated_at`, `last_used_at`;
- `use_count`, `view_count`, `patch_count` (each value includes its observation source and update time);
- `revision`, `content_hash`, `package_hash`, `replaced_by`, `source_session_ids`;
- `validation_status`, `risk_level`, `version_history`.

`owner` and `management_policy` are separate concepts. Unknown authorship must not be treated as consent to automatic management.

Discover all available OpenCode skills through the supported Skills API (`ctx.skill.list()`). If necessary, additionally index only explicitly configured, permitted directories. External and third-party records default to `readonly`; visibility in the catalog does not imply permission to write to disk.

Write plugin-created skills as packages containing `SKILL.md` in the user-selected global or project directory. Refresh visibility through `ctx.skill.reload()` or a compatible mechanism in the selected SDK version.

### 5.2. Plugin Data

Store the following separately:

- `skills`: catalog metadata;
- `skill_versions`: package/manifest snapshots and references to stored files;
- `sessions`: processing cursors and provenance;
- `learning_candidates`: extracted reusable observations;
- `proposals`, `proposal_changes`: proposals, diffs, and decisions;
- `jobs`, `job_attempts`, `job_leases`: jobs and execution records;
- `events`, `audit_log`: events and the action log;
- `settings`: global and scoped settings;
- `usage`: observed usage facts, without assuming that a lack of observations means a lack of use.

Store all long-lived information independently of any individual session. Restore state and unfinished jobs after a restart. Do not store secrets in plaintext.

## 6. Skill Learner: Learning from History

### 6.1. Input

History from ordinary conversations, completed tasks, child sessions, and their results, including the following when available:

- the user's goal and project context;
- agent steps, tool calls, and tool results;
- errors, retries, and verified fixes;
- the final result and explicit user feedback;
- skills used and their effect;
- references to source records for traceability.

Analyze completed stages of long tasks as well as whole sessions. Extraction may run after task completion or in batches over history. Do not treat an agent's unverified hypothesis as a successful solution.

### 6.2. Collection and Recovery

1. Subscribe to OpenCode's documented event stream (`ctx.event.subscribe`) and the relevant available lifecycle/tool hooks.
2. When work or a stage completes, append the event to a durable backlog. Do not invoke a heavyweight LLM directly from the event handler.
3. Use `ctx.session.list()` and `ctx.session.context()` to read accessible context. Do not assume these methods provide a complete raw archive of every tool output. Obtain missing required data from the plugin's event collector or a supported history importer.
4. Support explicit import of sessions/transcripts from VALERIA through the API, with ownership and provenance checks.
5. Deduplicate by `(source_instance, session_id, stage_id, content_hash)`, persist a cursor, and support requested reprocessing without duplicate results.
6. Exclude the plugin's own internal sessions using metadata or a system registry. Do not learn from Curator/Learner sessions, to prevent recursion.

### 6.3. Knowledge Selection

The intermediate `LearningCandidate` entity contains `title`, `problem`, `solution`, `conditions`, `evidence`, `failures`, `confidence`, `scope`, `reusability_score`, `source_refs`, and `sensitive_flags`.

Rank candidates by transferability, recurrence, evidence, project specificity, and potential savings. Do not create a new skill from every conversation. If an existing skill already covers the knowledge, propose a `patch`; if it duplicates existing knowledge, propose `merge` or `skip`.

### 6.4. Triggers

Configurable triggers: `on_session_end`, `on_stage_end`, `every_n_sessions`, `interval`, `manual_only`, and `on_demand` (RPC/TUI). Support `min_age`, `debounce`, `quiet_hours`, `max_backlog`, `retention_days`, token/cost budgets, and a minimum source quality threshold. The first run must not unexpectedly process the entire historical archive without explicitly configured retrospective import.

## 7. Skill Curator: Library Maintenance

### 7.1. Operations

- `review`: analyze library contents to identify duplicates, contradictions, missing dependencies, and outdated material;
- `create`: create a new skill package;
- `patch/refine`: make targeted changes to instructions and package files;
- `merge`: combine two or more skills while preserving provenance references;
- `split`: divide an overly broad skill into logical parts;
- `archive`: remove a skill from the active catalog without losing files or history;
- `restore`: restore a skill from the archive;
- `pin/unpin`: prevent automatic archival and absorption into another skill;
- `lock/unlock`: prevent all automatic changes to content and state;
- `adopt/unadopt`: configure the automatic management policy;
- `rollback`: restore a selected version;
- `export/import`: transfer a package with validation.

**No merge may lose content** from `scripts/`, `references/`, `templates/`, or `assets/`, relative links, or required supporting files. Where consumers depend on an old `skill_id`, create a `superseded -> target` mapping; update references only after dependency analysis when necessary.

### 7.2. States and Policy

- `active → stale → archived`: follow configurable age thresholds and checks. Suggested starting values are `30/90 days`, but these are not fixed.
- `archived → active`: requires explicit restoration.
- `active → superseded`: only after a merge has been applied successfully.
- `pinned`: excluded from automatic archival and merging.
- `locked`: automatic processes may not make changes. Only an explicitly authorized manual action by the owner or administrator may remove the lock.
- `manual` and `readonly`: automatic modification and archival are prohibited until explicit `adopt` or permission.
- `use_count = 0` **is not** sufficient grounds for deletion or archival.

LLM review is optional and configured separately from inexpensive deterministic checks. Never delete data irreversibly through automatic maintenance. Archive cleanup is a separate operation requiring confirmation, a backup, and an audit record.

### 7.3. Proposal-First Workflow

Every LLM operation returns a **proposal**, rather than modifying a file immediately:

1. Collect the target skills, complete packages, related dependencies, and provenance.
2. Build a plan using `create | update | merge | split | archive | restore`.
3. Create the new package or patch in an isolated staging area, including the diff, reasons, affected files, and sources.
4. Run checks for the SKILL.md schema, paths, hashes, secrets, links, version conflicts, ownership policy, potentially dangerous commands, size, and dependency integrity.
5. If skill tests or control scenarios are available, run safe checks in an isolated environment. Do not execute arbitrary skill code merely to "validate" it.
6. Apply after approval, or under an explicitly configured automatic policy for eligible skills and acceptable risk.
7. Atomically write files and metadata, save the version, request a reload, verify the catalog, and commit or roll back the transaction.

A concurrent editing conflict, where `revision` or `package_hash` has changed, blocks automatic application. Recreate the proposal or reconcile it manually.

## 8. Internal LLM Job Execution: Selectable Mode

### 8.1. Modes

| Mode       | Execution                                                                            | VALERIA required        | Use                                        |
| ---------- | ------------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------ |
| `direct`   | `ctx.experimental.generate.text()` or compatible generation without an agent session | No                      | Analysis, classification, JSON proposals   |
| `session`  | A separate OpenCode service session (`ctx.session.create/prompt/wait`)               | No                      | Complex agentic review with tools          |
| `valeria`  | Job execution inside VALERIA through an external worker bridge or VALERIA queue      | Yes, for this mode only | Centralized resource management            |
| `external` | A pluggable external executor using the same worker contract                         | No                      | A separate compute service or orchestrator |
| `auto`     | Select from permitted modes according to availability and capability policy          | No                      | A convenient default mode                  |

By definition, `direct` cannot execute tools. Operations that need file reads or edits must receive data through the server core and return a declarative proposal, or switch to a previously authorized `session` or external mode. **The core writes to the catalog**, not arbitrary LLM commands.

No mode is privileged by default. Enabling `valeria` does not prohibit `direct` or `session`.

### 8.2. Configuration Precedence

1. Explicit `execution.mode` in an individual job request.
2. Settings for the operation type (`learning`, `review`, `merge`, `update`).
3. Workspace/tenant settings.
4. Global plugin settings.

For `auto`, configure an ordered `preferred_modes` list (for example, `direct,session,external`), permitted capabilities, and a fallback policy. Fallback is allowed only **before confirmed acceptance** by an executor. An uncertain outcome must not automatically trigger another LLM run.

### 8.3. Per-Job Parameters

`model`, `provider`, `variant`, `temperature`, `max_tokens`, `max_iterations`, `timeout_sec`, `priority`, `max_cost_usd`, `max_parallel`, `execution.mode`, `fallback_policy`, `approval_mode`, `idempotency_key`, `scope`, `requested_by`.

Separate concurrency limits are required per `executor`, per `tenant/workspace`, and globally. VALERIA's external queue **does not affect** the limits of other modes; the plugin manages those limits itself. Support forced stopping, graceful pause, recovery, and cost monitoring.

### 8.4. Job States

`created → queued → claimed/running → completed | failed | cancelled`; additional states are `waiting_executor`, `retry_scheduled`, `waiting_approval`, `interrupted`, and `unknown_outcome`.

A `Job` stores `job_id`, `operation`, `scope`, `executor_mode`, `status`, `attempt`, `created_at`, `updated_at`, `progress`, `cost`, `source_refs`, `proposal_ids`, `error`, `lease`, and `correlation_id`.

Retrying after connection loss must not start a second executor. Use an `idempotency_key`, a durable lease with a TTL, heartbeats, completion reconciliation, and an `unknown_outcome` policy.

### 8.5. VALERIA Queue Integration: Optional Adapter

Implement a pull worker for `valeria` mode:

1. The plugin creates a `Job` in `waiting_executor` or `queued` state with mode `valeria`.
2. An authorized VALERIA bridge periodically calls `jobs.lease` with type `valeria`, receiving a job and its input atomically leased to that bridge.
3. VALERIA creates an ordinary task/session of its own, preserving `job_id`, `idempotency_key`, and `correlation_id`. It may execute the task through its own FIFO queue.
4. The bridge sends `jobs.heartbeat` and progress updates. On completion, it calls `jobs.complete` with the structured LLM result, or `jobs.fail`.
5. The plugin validates the response, creates a proposal, and applies its own policy. VALERIA **does not write** skill files by bypassing the core.
6. After a timeout or restart, the bridge reconciles already accepted and completed VALERIA tasks using a durable marker. It does not create a duplicate when the outcome is unknown.

`external` mode uses the same interface with a different `worker_kind`. Starting a job from VALERIA through RPC with `execution.mode=direct` or `session` remains valid; it **does not** route the job into VALERIA's queue.

## 9. Skill Manager: OpenCode Interface

The `/skills-manager` command opens a dedicated TUI route in OpenCode v2. Quick commands: `/skills-review`, `/skills-learn`, `/skills-jobs`, and `/skills-settings` (the exact names may support configurable aliases).

The manager screen includes:

- a table with search, filters (`scope`, `owner`, `managed`, `state`, `tag`, `used`, `changed`), and sorting;
- a selected skill panel with its description, every file's contents, provenance, version, usage, and dependencies;
- multiple selection for `merge`, `archive`, `pin`, `adopt`, and `export`;
- a proposal list with before/after diffs and individual `approve/reject` actions;
- `Review all`, `Learn history`, `Sync catalog`, and `Undo/Rollback` buttons;
- a job log showing executor, status, progress, attempts, cost, errors, and cancel/retry buttons;
- settings for runs, including separate LLM execution modes, budgets, and automatic management policies;
- the audit log and archive viewer;
- confirmation for potentially destructive actions and a warning when changing manual skills.

Use supported TUI facilities: commands/keymaps, JSX routes, dialogs, and RPC event subscriptions. Server logic must not depend on an open TUI. With VALERIA, build the manager interface in its web application over **the same RPC API**. Server RPC cannot guarantee that it can "open a window" in an arbitrary local TUI client, so `manager.open` is a local TUI command and `manager.snapshot` is a public API operation.

## 10. Public API for VALERIA (Required)

### 10.1. Transport

Provide typed RPC v1 based on `Rpc.define`, exporting the contract as `opencode-skill-curator/rpc`. The server registers its implementation through `ctx.rpc.register`. External clients call RPC through `@opencode/client` and the OpenCode server. A separate REST server is not required. If VALERIA needs Python/HTTP without a TypeScript client, provide a documented HTTP-compatible bridge/SDK with the same schemas, permissions, and errors. Do not invent unstable OpenCode HTTP routes.

All methods use `scope={tenant_id?,workspace_id?,directory?}` and the authenticated caller's context. Scope **is determined by server authorization**, not merely by client-supplied strings. The API must work with local or remotely hosted VALERIA when secure network access to OpenCode is available.

### 10.2. RPC Methods

**System management:**

| Method                            | Purpose                                                                     |
| --------------------------------- | --------------------------------------------------------------------------- |
| `system.health`                   | Health, version, available capabilities, storage, and executor availability |
| `system.status`                   | Overall state, backlog, active jobs, errors, and metrics                    |
| `system.capabilities`             | Supported operations, schema versions, and allowed modes                    |
| `system.pause` / `system.resume`  | Pause/resume automatic processing for a selected scope and subsystem        |
| `system.shutdown_work`            | Gracefully stop background processing without unloading the plugin          |
| `settings.get` / `settings.patch` | Read/change settings with `revision` checking and validation                |
| `settings.validate`               | Validate settings without applying them                                     |
| `settings.reset`                  | Reset the selected scope to defaults                                        |
| `manager.snapshot`                | Data for building the complete manager in VALERIA                           |
| `manager.refresh`                 | Reindex all visible skills and check for disk changes                       |

**Skills:**

| Method                                 | Purpose                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| `skills.list` / `skills.get`           | Catalog, filters, pagination, full package, and metadata |
| `skills.search`                        | Search by name, description, content, and tags           |
| `skills.create`                        | Create a new skill from a validated package              |
| `skills.update`                        | Make a manual change with an expected version            |
| `skills.rename` / `skills.clone`       | Rename / clone                                           |
| `skills.merge.preview`                 | Propose a merge of selected skills                       |
| `skills.split.preview`                 | Propose a split                                          |
| `skills.archive` / `skills.restore`    | Archive / restore                                        |
| `skills.pin` / `skills.unpin`          | Protect against automatic archival and merging           |
| `skills.lock` / `skills.unlock`        | Prohibit / allow automatic modification                  |
| `skills.adopt` / `skills.unadopt`      | Grant / revoke automatic management                      |
| `skills.history` / `skills.diff`       | List revisions and compare versions                      |
| `skills.rollback`                      | Restore a version                                        |
| `skills.import` / `skills.export`      | Import / export a package                                |
| `skills.usage` / `skills.dependencies` | Usage and dependencies                                   |

**Analysis, learning, and proposals:**

| Method                                   | Purpose                                                  |
| ---------------------------------------- | -------------------------------------------------------- |
| `learning.run`                           | Analyze selected sessions or a history range             |
| `learning.ingest`                        | Explicitly import a sanitized transcript with provenance |
| `learning.candidates`                    | Inspect extracted knowledge                              |
| `learning.backfill`                      | Import historical data with a cursor and limits          |
| `curator.review`                         | Perform an in-depth review of all or selected skills     |
| `curator.analyze_duplicates`             | Identify merge candidates                                |
| `curator.lifecycle_run`                  | Perform deterministic stale/archive maintenance          |
| `curator.update`                         | Review a specific skill and propose updates              |
| `proposals.list` / `proposals.get`       | Proposals, diffs, risks, and sources                     |
| `proposals.validate`                     | Revalidate against the current file versions             |
| `proposals.approve` / `proposals.reject` | Approve / reject                                         |
| `proposals.apply`                        | Transactionally publish an approved change               |
| `proposals.cancel`                       | Cancel a proposal that has not been applied              |

**Jobs and executors:**

| Method                                | Purpose                                                |
| ------------------------------------- | ------------------------------------------------------ |
| `jobs.list` / `jobs.get`              | Jobs with filters and states                           |
| `jobs.run`                            | Any supported operation with executor parameters       |
| `jobs.pause` / `jobs.resume`          | Pause / resume a queued job                            |
| `jobs.cancel` / `jobs.retry`          | Cancel / retry with the same idempotency marker        |
| `jobs.progress` / `jobs.logs`         | Progress and sanitized logs                            |
| `jobs.lease`                          | Atomically acquire external work by `worker_kind`      |
| `jobs.heartbeat`                      | Renew the lease and report progress                    |
| `jobs.complete` / `jobs.fail`         | Finish external execution                              |
| `executors.list` / `executors.status` | Executor availability                                  |
| `executors.test`                      | Test an executor without publishing skills             |
| `executors.set_policy`                | Selection modes and limits, requiring admin permission |

**Monitoring:**

`stats.overview`, `stats.learning`, `stats.skills`, `stats.costs`, `audit.list`, `events.replay`.

Methods returning large collections support `limit`, `cursor`, and `filters`. Events must not be the only way to recover status. `events.replay` reads a durable event log rather than only the live RPC stream.

### 10.3. Required RPC Events

- `skill.created`, `skill.updated`, `skill.archived`, `skill.restored`, `skill.merged`, `skill.locked`;
- `proposal.created`, `proposal.validated`, `proposal.approved`, `proposal.applied`, `proposal.rejected`;
- `job.created`, `job.started`, `job.progress`, `job.waiting_executor`, `job.completed`, `job.failed`, `job.cancelled`;
- `settings.changed`, `manager.refreshed`, `health.changed`.

Payload: `event_id`, `occurred_at`, `scope`, `actor`, `correlation_id`, `entity_id`, `entity_revision`, and typed details. Events are available to subscribers, **but events missed during a disconnection are recovered through `events.replay`**. VALERIA must process events idempotently.

### 10.4. Logical Request Examples

Start a review _without using VALERIA's queue_:

```json
{
  "method": "curator.review",
  "input": {
    "scope": { "workspace_id": "ws-12" },
    "skill_ids": ["gitlab-auth", "gitlab-token-fix"],
    "execution": { "mode": "session", "max_cost_usd": 0.75 },
    "dry_run": true,
    "idempotency_key": "review-ws12-20261113"
  }
}
```

Start through VALERIA's queue:

```json
{
  "method": "learning.run",
  "input": {
    "scope": { "workspace_id": "ws-12" },
    "session_ids": ["ses-001", "ses-002"],
    "execution": { "mode": "valeria", "priority": "low" },
    "idempotency_key": "learn-001-002"
  }
}
```

Manual management:

```json
{
  "method": "skills.archive",
  "input": {
    "scope": { "workspace_id": "ws-12" },
    "skill_id": "obsolete-deploy",
    "expected_revision": 7,
    "reason": "Replaced by deploy-v2",
    "idempotency_key": "archive-obsolete-deploy-r7"
  }
}
```

These are **logical RPC contract envelopes**, not a promise that a route such as `/api/curator/review` exists. Actual transport uses the OpenCode RPC client or a compatible adapter.

### 10.5. Response and Error Standards

A management request returns `request_id`, `correlation_id`, `resource_id`/`job_id`/`proposal_id`, `status`, `revision` (where applicable), and `created_at`. Heavy operations are always asynchronous: the response acknowledges job acceptance rather than returning a completed diff.

Typed errors: `unauthorized`, `forbidden`, `not_found`, `validation_error`, `revision_conflict`, `scope_violation`, `locked_skill`, `readonly_skill`, `executor_unavailable`, `rate_limited`, `budget_exceeded`, `idempotency_conflict`, `lease_expired`, `unknown_outcome`, `internal_error`. Do not expose private paths or secrets to other tenants in error messages.

## 11. Configuration

An example of the **target plugin schema**, not a declaration of existing OpenCode fields:

```jsonc
{
  "enabled": true,
  "auto_learning": {
    "enabled": true,
    "on_session_end": true,
    "every_n_sessions": 5,
    "include_child_sessions": true,
    "backfill_on_first_start": false,
  },
  "curator": {
    "enabled": true,
    "interval_hours": 168,
    "llm_review_enabled": false,
    "stale_after_days": 30,
    "archive_after_days": 90,
    "archive_requires_evidence": true,
  },
  "execution": {
    "default_mode": "auto",
    "auto_preferred_modes": ["direct", "session"],
    "fallback_before_accept_only": true,
    "max_parallel_total": 2,
    "max_parallel_per_workspace": 1,
    "operation_modes": {
      "learning": "direct",
      "review": "session",
      "merge": "session",
      "update": "direct",
    },
  },
  "approval": {
    "mode": "manual",
    "allow_auto_patch_managed_low_risk": false,
    "allow_auto_archive_managed": false,
    "protect_manual_skills": true,
  },
  "limits": {
    "daily_cost_usd": 3.0,
    "max_job_cost_usd": 1.0,
    "max_context_tokens": 45000,
  },
  "privacy": {
    "redact_secrets": true,
    "send_raw_transcripts_to_external": false,
    "exclude_internal_sessions": true,
  },
  "valeria_bridge": {
    "enabled": false,
    "worker_kind": "valeria",
    "lease_seconds": 120,
  },
}
```

Configuration is available through the TUI and `settings.get/patch`. Changes support optimistic locking and auditing. Changing executor policy does not cancel an already running job or automatically transfer it between executors. A `safe mode` disables automatic publication, allowing only proposals and manual review.

## 12. Security and Multiuser Operation

1. **Tenant isolation:** sessions, skills, tokens, archives, proposals, and jobs belonging to one tenant/workspace are inaccessible to another by default. Publishing global skills requires explicit administrator permission.
2. **API authorization:** OpenCode network access is protected by its authentication mechanism. The plugin additionally checks application permissions and permitted scope. Roles: `viewer`, `editor`, `curator`, `administrator`, `worker`. Do not trust a client-supplied `tenant_id` without a server-side binding.
3. **File permissions:** allowlist root directories, verify realpaths, and prevent `..`, symlink traversal, and hardlinks outside the permitted scope. External packages default to readonly.
4. **Untrusted history:** user text, tool output, and discovered documents are **data**, not instructions for the curator. Use strict system rules, typed output, proposal validation, and a prohibition on direct shell commands during application.
5. **Secrets:** filter API keys, cookies, passwords, tokens, private paths, and PII before sending data to the model and before writing to SKILL.md. Mask them in logs and reports.
6. **External executors:** a worker receives only the minimum necessary context, with a separately configurable disclosure level, a signed/authenticated channel, and a lease-bound capability. Workers cannot call `proposals.apply` without permission.
7. **Approval:** user and third-party skills are not modified automatically. All publication paths must honor `pin` and `lock`. An administrative override requires an explicit action with a reason and audit record, never a model instruction.
8. **Code execution policy:** skills may contain scripts, but they must not be executed automatically without isolation and an established policy. Viewing contents is not execution.
9. **Versions:** every change has an author, source, diff, checksum, and rollback mechanism. Do not log complete secret-bearing transcripts.
10. **Fail-safe behavior:** block publication and show the reason when the database is corrupted, permissions are lost, an external job has an uncertain outcome, or validation fails.

## 13. Development Plan

### Phase A: Core and API

OpenCode v2 integration, skill catalog, local database, stable `skill_id`/revision, creation/editing/archival/restoration, versioning, RPC, authentication, audit, and TUI listing and inspection. **Outcome:** VALERIA can manage the library programmatically without an LLM.

### Phase B: Executors and Jobs

State machine, `direct`/`session`, mode configuration, limits, budgets, cancellation, retries, idempotency, and `valeria`/`external` bridges with durable leases. **Outcome:** a job can run in any permitted mode independently of VALERIA's queue.

### Phase C: Learner

Event collection, retrospective import, recursion prevention, candidate extraction, existing skill search, and proposal generation. **Outcome:** completed work produces verifiable proposals for new skills and improvements.

### Phase D: Curator

Duplicates, merge/split, preservation of complete packages, stale/archive maintenance, tests/validation, approvals, rollback, TUI diffs, and batch operations. **Outcome:** the library is kept current through automatic and manual maintenance.

### Phase E: VALERIA Integration and Polish

VALERIA administration panel through RPC, monitoring/events, tenant/workspace bindings, metrics, recovery stress tests, documentation, and npm publication.

## 14. Acceptance Criteria (Definition of Done)

1. The plugin starts in a clean OpenCode v2 installation **without VALERIA**. Users can open `/skills-manager` and manage skills.
2. VALERIA can retrieve the entire permitted catalog, contents, versions, proposal list, job status, and settings through RPC.
3. VALERIA can create, update, merge, archive, and restore skills with safe permission and version checks.
4. `curator.review` and `learning.run` accept `execution.mode=direct`, `session`, `valeria`, `external`, and `auto`. Each works when its executor is configured.
5. When the user selects `direct` or `session`, jobs **are not sent** to VALERIA's queue. When the user selects `valeria`, they execute there.
6. The execution mode is selectable per call, per operation, and through settings. Changing a setting does not transfer an active job.
7. If VALERIA is disabled, independent modes continue working. Explicitly selecting `valeria` returns `executor_unavailable` when no bridge is available.
8. Losing the VALERIA connection does not create duplicate LLM jobs. An unknown outcome is marked and reconciled.
9. Two concurrently approved changes to the same skill do not overwrite each other: one receives `revision_conflict`.
10. Repeating an RPC request with the same idempotency key does not duplicate the operation. A conflicting payload is rejected.
11. Automatic processes do not modify `manual`, `readonly`, `locked`, or `pinned` skills against policy. Manual unlocking is logged.
12. Merging preserves all required files, paths, dependencies, and rationale. Original packages remain available for restoration.
13. Skills, versions, proposals, settings, leases, and jobs survive restarts, and execution recovers correctly.
14. Incorrect or malicious conversation text cannot apply a proposal, change settings, or access another workspace on its own.
15. Transcript secrets do not appear in published SKILL.md files or external executor payloads when their transmission is prohibited.
16. Each change is traceable: source → learning candidate → proposal → approval → version → audit.
17. `dry_run` shows potential changes without writing files.
18. Calling `ctx.skill.reload()` or its equivalent makes new skills available in subsequent sessions without a manual restart, when supported by the installed OpenCode version.
19. Documentation covers installation, configuration, RPC examples, VALERIA integration, security policy, upgrades, and troubleshooting.
20. CI covers unit, integration, permission, RPC contract, crash/retry, and end-to-end creation/merge/rollback tests.

## 15. Required Test Scenarios

- A new session yields a successful solution → LearningCandidate → proposal for a new SKILL.md → approval → availability in OpenCode.
- Three similar skills → merge proposal → diff → apply → original packages archived, new skill available.
- Partially overlapping skills → Curator refuses an unsafe merge and explains why.
- A skill has not been used for 90 days but is locked, pinned, or manual → it is not archived.
- The validator detects an unsafe path or token leak → publication is blocked.
- A skill is edited manually after proposal generation → `revision_conflict`, with no overwrite.
- A long user session and concurrent review → independent execution without blocking one another.
- `direct` mode → no OpenCode agent session and no VALERIA queue.
- `session` mode → a separate service session excluded from self-learning.
- `valeria` mode → lease/heartbeat/complete; a repeated request with the same idempotency key returns the same job.
- The VALERIA bridge dies after creating a task → recovery through the durable marker, with no duplicate.
- `auto` mode with VALERIA disabled → uses a permitted local executor.
- Multiuser test: another tenant cannot read a private skill or diff, even when it knows their IDs.
- OpenCode restarts during apply → either a fully applied valid version or rollback, never a partially broken package.

## 16. Required Deliverables

- A working npm package with a supported OpenCode v2 version and server/tui/rpc exports.
- Source code and tests.
- `README.md` and technical documentation.
- A documented, typed RPC contract, TypeScript client examples, and a Python/HTTP adapter for VALERIA.
- State migrations and backup/restore instructions.
- Example configurations for standalone operation and VALERIA integration.
- Architecture and data model diagrams.
- CI with access, idempotency, recovery, and skill lifecycle tests.

---

## 17. Technical Alignment with Current OpenCode v2

Confirmed official SDK primitives on which the implementation may rely:

- `Plugin.define`, with `server`, `tui`, and `rpc` components;
- `ctx.rpc.register` / `Rpc.define`, with external calls through `@opencode/client`;
- `ctx.skill.list`, `ctx.skill.transform`, `ctx.skill.reload`;
- `ctx.session.create`, `ctx.session.context`, `ctx.session.prompt`, `ctx.session.wait`, `ctx.session.list`;
- `ctx.experimental.generate.text` (**experimental API**, requiring a compatibility adapter);
- `ctx.event.subscribe`, `ctx.tool.hook('execute.before'/'execute.after')`;
- `ctx.storage.get/set/scan`;
- TUI `context.ui.router.register`, `context.keymap.layer`, and dialogs;
- RPC event subscriptions.

**Important:** the RPC method names in section 10 and configuration in section 11 are **requirements for the new plugin, not existing OpenCode methods**. Transcript structure, exact lifecycle events, and history completeness must be verified against the pinned SDK version with integration tests. If standard `session.context` does not expose some data, provide event capture or an import source rather than assuming unrestricted access to the archive.

### Developer Sources

- OpenCode v2 Plugins Overview — https://opencode.ai/docs/build/plugins/
- OpenCode v2 Server Plugin API — https://opencode.ai/docs/build/plugins/server/
- OpenCode v2 TUI API — https://opencode.ai/docs/build/plugins/cli/
- OpenCode v2 RPC API — https://opencode.ai/docs/build/plugins/rpc/
- Hermes Agent Curator (behavior reference) — https://hermes-agent.nousresearch.com/docs/user-guide/features/curator
- VALERIA — https://github.com/ProALgebra/VALERIA
