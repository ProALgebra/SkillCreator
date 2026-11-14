# RPC: skill-curator.v1

The contract is exported from `opencode-skill-curator/rpc` as `SkillCurator`. The server registers it through the SDK's `ctx.rpc.register`. Client usage: `OpenCode.make(...).rpc(SkillCurator)['skills.list'](input)`. The public `CuratorClient` also validates responses against `outputSchemas`; catalog, proposal, and job types are exported from `rpc`.

## Request envelope

```json
{
  "auth": "CAPABILITY_FROM_ENVIRONMENT",
  "scope": { "workspace_id": "my-project" },
  "skill_id": "stable-uuid",
  "expected_revision": 3,
  "idempotency_key": "archive-skill-r3",
  "reason": "Replaced with a verified procedure"
}
```

`tenant_id` is optional: the server derives it from the Principal. A different tenant or an unauthorized workspace is rejected even for administrators. `scope.directory` grants no extra permission and cannot select an arbitrary disk path. Select the OpenCode location through standard client request options.

`settings_level=workspace|tenant|global` selects the settings layer. Workspace settings inherit tenant and global patches; responses include `inherited_revisions`. Changing the global layer requires a server-bound `global_admin`, beyond the tenant administrator role. On create/import, `skill_scope=global` publishes the skill to other workspaces within the same tenant; an administrator must make subsequent changes from the owning workspace.

Mutations require an idempotency key, except lease/heartbeat/complete/fail, which use their own lease capability. Repeating the same payload returns the saved response; a different payload with the same key produces `idempotency_conflict`. A crash between request acceptance and saving the result produces `unknown_outcome`: reconcile the catalog/jobs instead of creating a new operation.

Responses contain `request_id`, `correlation_id`, `created_at`, `status`, and entity fields (`skill_id`, `proposal_id`, or `job_id`). Changes increment the revision. Collections use `{items, total, cursor}`; pass `limit` (1–200, default 50), the next `cursor`, and `filters`. In the current local version, the cursor is an opaque offset string; do not treat it as a stable snapshot during concurrent changes.

## Methods

| Group        | Methods                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| system       | health, status, capabilities, pause, resume, shutdown_work                                                                                                                                               |
| settings     | get, patch, set_publication_mode, validate, reset                                                                                                                                                        |
| manager      | snapshot, refresh                                                                                                                                                                                        |
| skills       | list, get, search, create, update, rename, clone, merge.preview, split.preview, archive, restore, pin, unpin, lock, unlock, adopt, unadopt, history, diff, rollback, import, export, usage, dependencies |
| learning     | run, refine, sessions, ingest, candidates, backfill                                                                                                                                                      |
| curator      | review, optimize, status, rollback, analyze_duplicates, lifecycle_run, update                                                                                                                            |
| proposals    | list, get, validate, approve, reject, apply, cancel                                                                                                                                                      |
| jobs         | list, get, run, pause, resume, cancel, retry, progress, logs, lease, heartbeat, complete, fail                                                                                                           |
| executors    | list, status, test, set_policy                                                                                                                                                                           |
| stats        | overview, learning, skills, costs                                                                                                                                                                        |
| audit/events | audit.list, events.replay                                                                                                                                                                                |

All 80 methods are registered. A shared strict input schema rejects unknown fields; handlers also enforce operation-specific required arguments. The current method list and Zod schemas are in `src/rpc.ts`.

## Operation arguments

| Operation                                           | Fields in addition to the common envelope                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| create/import                                       | `files: {"SKILL.md": "---...", "assets/a.bin": "base64:..."}`                                                    |
| update                                              | `skill_id`, `expected_revision`, complete replacement `files`                                                    |
| rename/clone                                        | `skill_id`, `name`; rename also requires `expected_revision`                                                     |
| archive/restore/pin/unpin/lock/unlock/adopt/unadopt | `skill_id`, `expected_revision`; unlock requires `reason`                                                        |
| merge.preview                                       | At least 2 `skill_ids`, plus `name`; creates a high-risk proposal                                                |
| split.preview                                       | `skill_id`, `parts`: an array of complete packages; dependency loss is prohibited                                |
| history/diff/rollback                               | `skill_id`; diff: `from_revision`, `to_revision`; rollback: `target_revision`, `expected_revision`               |
| proposals.approve/reject/cancel/apply               | `proposal_id`, the proposal's `expected_revision`                                                                |
| learning.ingest                                     | `transcript: {source_instance, session_id, stage_id, content, verified, source_refs?, internal?}`                |
| learning.backfill                                   | `transcripts`, `limit?`, `cursor?`; explicit import rather than an implicit archive-wide scan                    |
| learning.run                                        | `session_ids?`, `execution?`; omitting IDs selects unprocessed sources                                           |
| learning.sessions                                   | `limit?`; recent and archived conversations in the current project, excluding internal sessions                  |
| learning.refine                                     | `session_ids:[one ID]`, `reason?` (focus), `execution?`; analyzes an untrusted conversation snapshot             |
| curator.review/update                               | `skill_ids?` / `skill_id?`, `execution?`                                                                         |
| curator.lifecycle_run                               | No LLM; findings and stale/archive proposals deduplicated by revision                                            |
| jobs.run                                            | `operation`: learning/review/merge/update, `execution`, `skill_ids?`, `session_ids?`; merge also requires `name` |
| jobs.pause/resume/cancel/retry                      | `job_id`; retry is allowed only after a confirmed failed outcome                                                 |
| settings.patch                                      | `patch`, the settings' `expected_revision`                                                                       |
| settings.set_publication_mode                       | `publication_mode`: auto/manual, `expected_revision`; administrator only, `settings_level?`                      |
| executors.set_policy                                | Execution `patch`, the settings' `expected_revision`                                                             |
| jobs.lease                                          | `worker_id`, `worker_kind`: valeria/external                                                                     |
| jobs.heartbeat                                      | `job_id`, `worker_id`, `lease_token`, `progress` from 0 to 1                                                     |
| jobs.complete                                       | `job_id`, `worker_id`, `lease_token`, `result`, `cost_usd`                                                       |
| jobs.fail                                           | `job_id`, `worker_id`, `lease_token`, `error`, `cost_usd?`                                                       |

`expected_revision` belongs to the entity being changed; proposals and skills have independent counters. A new proposal records the revisions of all affected skills. After approval, use the proposal's new expected revision. A changed source package blocks apply even if the proposal remains approved.

For an unknown local outcome, an administrator can explicitly confirm that execution stopped with `jobs.cancel({job_id,confirm_stopped:true,reason,cost_usd,idempotency_key})`. This is an audited operator statement after verifying the actual stop and cost; it releases retained concurrency/budget reservations. Ordinary cancellation does not imply this confirmation.

`skills.list/search` filters: `scope`, `owner`, `state`, `management_policy`, `managed`, `tag`, `used`, `pinned`, `locked`, `name`. Sort fields: `name`, `updated_at`, `use_count`. Search includes file contents. Settings are returned with their revision.

## Switching publication mode

`settings.set_publication_mode` is a dedicated administrator endpoint. Read `settings.get` first, then pass its `revision`:

```ts
const current = await curator['settings.get']({ auth }, { location });
await curator['settings.set_publication_mode'](
  {
    auth,
    publication_mode: 'auto',
    expected_revision: current.revision,
    idempotency_key: crypto.randomUUID(),
  },
  { location },
);
```

`auto` sets `approval.mode=auto`, `allow_auto_create=true`, and `allow_auto_patch_managed_low_risk=true`. `manual` sets `mode=manual` and both flags to false. Other settings, including separate archive and merge permissions, are preserved. The response contains the revision and effective settings. `dry_run=true` validates settings without writing; settings layers and inheritance are supported. Viewers, editors, curators, and workers cannot change the mode. Switching does not apply existing pending proposals; it governs subsequent analysis results. To disable it, pass `publication_mode:'manual'` with a new revision and idempotency key.

## Jobs and model output

`execution.mode`: direct/session/valeria/external/auto. Accepted parameters also include model/provider/variant, timeout_sec, max_tokens, max_iterations, priority, max_cost_usd, max_parallel, fallback_policy, and approval_mode. These are persisted in the job; [ACCEPTANCE.md](ACCEPTANCE.md) describes which parameters the built-in SDK adapter can enforce. Workers receive the complete policy and must honor it.

Learner output:

```json
{
  "candidates": [
    {
      "title": "Retry policy",
      "problem": "Transient failure",
      "solution": "Keep a durable marker",
      "conditions": [],
      "evidence": ["verbatim evidence from verified source"],
      "failures": [],
      "confidence": 0.95,
      "reusability_score": 0.9,
      "source_refs": ["session-id"]
    }
  ]
}
```

`learning.refine` uses the same candidate format but requires a kebab-case `name`. To refine an existing skill, include a `target_skill_id` from the supplied catalog and a matching `name`. `source_refs` must contain only the exact `snapshot.snapshot_id` from the job context. The snapshot remains unverified; a quote does not become an independent test result. Executors may return `{"candidates":[]}`. Successful candidates with confidence ≥0.7 and reusability_score ≥0.6 produce proposals; others are stored as candidates only.

`learning.sessions` returns `{items:[{session_id,title}],total,cursor:null}`. It is a bounded selection of the latest `limit` available entries, not paginated access to the complete archive. `learning.refine` inherits the conversation's model when `execution.provider/model` are omitted. History is unavailable outside OpenCode unless the host supplies `CoreOptions.conversations`. External executors require an explicit privacy opt-in. `dry_run` checks availability, executor selection, and context size without saving a snapshot or creating a job.

Review/update output: `{"updates":[{"skill_id":"...","files":{"SKILL.md":"..."},"rationale":"..."}]}`. Merge assessment: `{"merge":false,"rationale":"Unsafe overlapping dependencies"}` or `merge=true`. Extra fields, fabricated source references, changed revisions, and secrets prevent result acceptance. A confirmed decision against merging completes the job without a proposal.

For create/update/merge/split/apply, `dry_run=true` validates the package and returns a potential result without writing files or accepting a job. Review dry-run returns deterministic findings and the selected executor. Dry-run of a proposal decision returns the current proposal without changing the decision.

## Events and errors

Events contain `event_id`, `occurred_at`, tenant/workspace, actor, correlation_id, entity_id, entity_revision?, and details. Required skill/proposal/job/settings/manager/health events are persisted in `events` and `audit_log`. The safe external delivery mechanism is currently `events.replay`; clients deduplicate by `event_id` and continue pagination. `manager.open` is not a remote operation: the local TUI opens the route.

Error codes: unauthorized, forbidden, not_found, validation_error, revision_conflict, scope_violation, locked_skill, readonly_skill, executor_unavailable, rate_limited, budget_exceeded, idempotency_conflict, lease_expired, unknown_outcome, internal_error. The SDK uses its declared error envelope; the HTTP bridge maps it to `{"error":{"code":"...","message":"..."}}`.

Library optimization (`curator.optimize/status/rollback`), plan format, continuation, and policy are documented in [CURATOR.md](CURATOR.md).
