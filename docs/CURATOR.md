# Automatic curator

The curator maintains managed skills in the current workspace: it identifies semantic overlap and proposes edits, merges, and archival. The model returns a declarative plan; the server validates it and saves immutable proposals. Fresh installations enable scheduled LLM optimization and automatic publication of eligible changes, including merging and evidence-backed archival. Existing saved settings are retained on upgrade.

## Controls

Open `/skills-optimize`:

- **Run now** performs a single review using the model selected in OpenCode.
- **Preview** shows the composition and size of batches without calling the model or writing to the database.
- **Automatic review → Semantic optimization** enables background passes. **Check for stale skills** runs lifecycle checks without an LLM; **Disabled** turns off the schedule.
- **Schedule and parameters** configures the interval, idle period, batch size, and model.
- **Automatic merging** separately permits merge proposals to be applied without approval. Publication must also be set to **Automatic** in `/skills-publication`.
- **Status and reports** shows the schedule, jobs, proposals, and changes to library size.
- **Pause curator / Resume curator** pauses the curator without stopping conversation learning.
- **Prepare rollback** creates an inverse proposal for one applied optimization. Review, approve, and apply it in the manager.

## Schedule and model

Defaults are a 168-hour interval, a minimum idle period of 2 hours, up to 8 skills per batch, and up to 8 batches per pass. The first plugin start saves an initial timestamp in the database and waits for a full interval. Reload does not reset the schedule. Activity events and native busy/idle checks prevent scheduled passes from starting during a response. Unresolved outcomes and already queued optimization jobs block a new pass; confirmed rejections before acceptance use retry backoff.

Manual review remains available when the schedule is disabled. Pausing `curator`/`all` or setting `settings.enabled=false` blocks manual runs. An automatic pass runs lifecycle checks first, then LLM optimization when `llm_review_enabled=true`.

JSON patch for the schedule and automatic merging:

```json
{
  "curator": {
    "enabled": true,
    "llm_review_enabled": true,
    "interval_hours": 168,
    "min_idle_hours": 2,
    "max_batch_skills": 8,
    "max_batches_per_run": 8,
    "provider": "deepseek",
    "model": "deepseek-flash"
  },
  "approval": { "mode": "auto", "allow_auto_merge": true }
}
```

Without an explicit override, scheduled review inherits the model of the most recent available primary conversation. If none is available, it uses OpenCode's base model. Manual commands pass the model selected in the TUI. Cost limits default to `null` (disabled); finite optional limits and concurrency checks use the shared job system. Built-in accounting retains the SDK limitations documented in [ACCEPTANCE.md](ACCEPTANCE.md).

## Plans and merging

Candidates are active or stale plugin-owned skills with `management_policy=managed` in the current workspace. Manual, readonly, pinned, locked, foreign-workspace, and global skills are excluded. The model receives complete packages after known secrets are redacted. Deterministic grouping uses similarity between names and descriptions; the model makes the semantic decision within each bounded batch. It does not exhaustively compare every possible pair in a large library.

Each supplied skill must appear exactly once in the plan: `keep`, `patch`, `merge`, or `archive`. For each changed source, the model supplies literal quotes from its instructions. Validation checks complete batch coverage, allowed identifiers, nonoverlapping actions, revisions/hashes, current policy, and actual files on disk.

A merge creates a coherent root `SKILL.md` shorter than the combined source root instructions. Every source file is preserved byte for byte under `sources/<skill_id>/`; the new instructions must link to relocated resources. Scripts are not executed. Source skills become `superseded` only when the proposal is applied. Patches preserve every supporting file and the skill name. With `archive_requires_evidence` enabled, archival requires observed usage and sufficient time since the most recent use/update.

Compression and quotes do not prove semantic equivalence. Reports explicitly contain `semantic_equivalence_verified:false`: the model may omit an important detail. Manual publication remains available through `/skills-publication` when review before application is desired. Root instructions may shrink while the full package grows because original source files are retained.

## Large libraries and reports

Each job contains one batch of complete context. Unreviewed identifiers remain in a durable continuation queue; `next_cursor` indicates remaining work. The context budget remains enabled at `limits.max_context_tokens=45000` by default. Oversized packages are skipped with `package_exceeds_context_limit`; protected packages use `protected_or_inactive`. Changes to reviewed skills do not reset the continuation: remaining skills receive current revisions/hashes when the next job is prepared. New skills enter the next full sweep. Run responses and reports include skipped entries. Group selection is heuristic and does not guarantee the smallest possible number of skills.

`curator.status` contains current library-wide metrics and per-batch reports. Each report distinguishes `before`, `proposed`, and `current`: proposed changes are never presented as applied. Metrics count active/stale skills, root-instruction characters, and complete-package characters. These are character counts, not exact counts from a provider-specific tokenizer.

A repeated plan for the same source revisions reuses the existing proposal, including a rejected proposal. A conflicting pending optimization for the same revision is blocked. When a finite daily budget is configured, it includes queued jobs and limits how many batches are accepted; the rest remain in the continuation queue. Accepted batches are enqueued transactionally; failure in a later batch rolls back acceptance of earlier batches.

## Rollback

Each proposal stores complete original packages and the expected state after application. `curator.rollback` creates an inverse proposal: it restores the original sources and archives the newly merged skill. Rollback requires separate approval even under automatic publication policy. Later changes to revision, hash, or state block rollback preparation and application. Rolling back one proposal does not undo other independent changes from the pass.

## RPC

- `curator.optimize`: `skill_ids?`, `skill_id?`, `cursor?`, `reason?`, `execution?`; an idempotency key is required to run. Returns `run_id`, `jobs`, `skipped`, `total`, and `next_cursor`. Dry-run returns batches without database writes.
- `curator.status`: settings, schedule, pause state, library metrics, recent jobs, and reports.
- `curator.rollback`: the applied optimization's `proposal_id`, that proposal's `expected_revision`, and an idempotency key; returns a pending inverse proposal. Supports dry-run.

Curators and administrators can run optimization and prepare rollback; authorized read roles can inspect status. Changing the schedule or publication permissions requires an administrator using `settings.patch`. Standard tenant/workspace isolation, global permissions, and external worker lease rules still apply.
