# Conversation analysis within a context budget

Conversation review keeps the complete redacted source available for validation while sending the model bounded requests. Large conversations use durable extraction and reconciliation jobs. A request does not silently discard the middle or end of its source to make it fit.

This applies to `/skills-refine`, RPC `learning.refine`, and automatically triggered conversation reviews. The verified-record Learner and library optimizer have different batching rules, described below.

## Source, parts, and final proposals

The source is the context returned by OpenCode's SDK for a stable, idle conversation. Secrets are redacted before the snapshot is saved. The complete accepted snapshot remains in the private sessions store; full transcripts are not copied into public job metadata or published as skill packages. Resulting skills can include validated evidence quotations. SDK compaction may already have removed original messages before capture. The plugin cannot recover those messages.

Analysis follows these stages:

1. Capture an immutable redacted snapshot with an exact identifier and content hash.
2. Prepare bounded parts that cover the entire source. Parts retain their source offsets, identifiers, and hashes. Splitting prefers message boundaries and keeps adjacent tool calls and results together when they fit; oversized messages can span several parts. Small overlaps help retain context at a boundary.
3. Extract reusable candidates and evidence-linked chronological observations from each part. An early successful command is not enough to override a later correction or failed outcome.
4. Reconcile the extracted material in source order. Additional bounded reduction passes merge duplicate candidates and carry forward relevant observations and corrections.
5. Validate the final candidates against the original captured evidence and current skill revisions. Only the final accepted result creates proposals. Source processing is completed after that final acceptance, rather than after an intermediate summary.

Part text is an exact source slice, so a part of a JSON conversation need not itself be standalone JSON. Offsets refer to UTF-16 positions in the redacted snapshot. The splitter does not divide a Unicode surrogate pair. A summary is model output, not proof: source references and literal quotations are checked against immutable source material, and an unsupported statement in a summary cannot establish a successful outcome.

Conversation material remains unverified even when a quotation is valid. Approval and publication policy still apply to the resulting proposals. The pipeline does not execute a procedure to independently verify it.

## Limits and settings

| Limit                | Behavior                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Full redacted source | At most 2,000,000 UTF-16 characters                                                               |
| Source parts         | At most 256; exceeding the cap returns `budget_exceeded`                                          |
| Calls per analysis   | `analysis.max_calls`, default 64, configurable up to 256                                          |
| Part overlap         | `analysis.overlap_chars`, default 128; reduced when necessary to respect boundaries and part size |
| Input size per call  | Derived from `limits.max_context_tokens`, with output and transport reserves                      |
| Cost                 | One analysis-wide allowance, also subject to daily and concurrency limits                         |

The source and part caps produce explicit errors. They do not return a successful analysis of a truncated prefix. A small context budget can also fail if the fixed prompt, catalog, source framing, or a required reconciliation request cannot fit.

Apply a settings patch through `/skills-settings` or `settings.patch`:

```json
{
  "analysis": {
    "max_calls": 64,
    "overlap_chars": 128
  },
  "limits": {
    "max_context_tokens": 45000,
    "max_job_cost_usd": 1,
    "daily_cost_usd": 3
  }
}
```

`settings.patch` requires the current settings revision and an idempotency key. Changing these limits does not change publication mode or grant permission to send transcripts to an external worker. External execution still requires `privacy.send_raw_transcripts_to_external=true`.

The input estimate uses three serialized UTF-16 characters per token. Before calculating the input allowance, it reserves `execution.max_tokens` for generated output, or a default output reserve, plus a transport margin. The complete serialized request counts toward that allowance: instructions, catalog, metadata, quotations, and escaped source text all consume space. `max_tokens` is an output allowance, not an input context size.

This is an approximation, rather than a provider-specific tokenizer. The plugin does not discover a model's live context window. Configure a suitable `max_context_tokens` for the chosen model; provider refusals remain possible. The SDK's enforcement and usage-reporting limits are documented in [acceptance and limitations](ACCEPTANCE.md).

## Cost and call accounting

For a multipart analysis, `execution.max_cost_usd` is the total analysis allowance. Omitting it uses the applicable `limits.max_job_cost_usd` default. Extraction, reconciliation, and reduction share that allowance; each child does not receive a fresh full allowance. Completed work and retained reservations count before further work is accepted. `analysis.max_calls` bounds calls across stages, including explicit retry attempts.

A valid result with no candidates can complete an analysis. An exhausted budget or call allowance does not turn unfinished work into success. When a provider or worker reports actual usage, that usage is accounted for; where the built-in SDK cannot report usage, reservations are charged conservatively. These limits bound plugin accounting, rather than establishing a hard provider invoice guarantee.

## Status, pause, and recovery

`learning.refine` returns the durable parent job. Its `waiting_parts` status means extraction or reconciliation work is still outstanding. The parent and its child jobs survive reloads, along with accepted partial results and their source references. Intermediate results do not publish skills.

For example, using the RPC client from the [RPC guide](RPC.md):

```ts
const parent = await curator['learning.refine'](
  {
    auth,
    session_ids: ['the-conversation-id'],
    execution: {
      mode: 'direct',
      provider: 'your-provider-id',
      model: 'your-model-id',
      max_cost_usd: 0.5,
      max_tokens: 4096,
    },
    idempotency_key: crypto.randomUUID(),
  },
  { location },
);

const state = await curator['jobs.get']({ auth, job_id: parent.job_id }, { location });
const progress = await curator['jobs.progress']({ auth, job_id: parent.job_id }, { location });
console.log(state, progress);
```

Use `/skills-jobs`, `jobs.get`, and `jobs.progress` to inspect the parent, linked work, progress, and errors. `jobs.list` and `jobs.logs` provide the individual job records and execution history.

- Pause or cancel the parent to propagate that request to its analysis children. An accepted executor may still need to acknowledge stopping. A pause does not prove that an already dispatched provider request stopped.
- Resume paused work with `jobs.resume`. Completed child results remain available; a normal continuation does not reread a newer version of the conversation.
- Use `jobs.retry` explicitly for a confirmed failed job when budget remains. Retrying uses the persisted source and completed work rather than silently starting another full analysis.
- `unknown_outcome` is not eligible for automatic retry or reassignment to another executor. Inspect the executor outcome first; the [RPC guide](RPC.md) describes audited cancellation reconciliation when an operator has confirmed the actual stop and cost.

For an explicit retry, pass a new idempotency key:

```ts
await curator['jobs.retry'](
  {
    auth,
    job_id: 'the-confirmed-failed-job-id',
    idempotency_key: crypto.randomUUID(),
  },
  { location },
);
```

Retrying a known failure and requesting a new analysis are different actions. Repeating a completed mutation with the same idempotency key returns its saved response; it does not reanalyze the current conversation.

## Verified-record Learner

`/skills-learn` and `learning.run` continue to accept only records marked `verified:true`. Before execution, the Learner freezes an exact batch of record identifiers and content hashes. Dispatch, evidence acceptance, and processing operate on that manifest, so a later import into the same conversation cannot silently become part of an already accepted job.

Deferred records continue in sequential bounded batches under the same overall analysis budget. A record that cannot fit on its own is reported explicitly as `record_exceeds_context_limit`; it is not silently shortened or marked processed. The verified-record path does not promote an unverified conversation snapshot to verified evidence.

## Skill-library optimizer

`curator.optimize` still batches complete skill packages. It can reduce a batch to fit the configured context budget and retain deferred skills for continuation. A single package that cannot fit is reported with `package_exceeds_context_limit`.

Conversation splitting does not enable partial-package editing. The optimizer does not split an oversized package into independently editable chunks or claim that omitted files were reviewed. See [the curator guide](CURATOR.md) for package preservation, protected skills, reports, and rollback.

## Verification scope

The context and orchestration behavior is checked with local automated tests and executor/SDK test doubles. This workflow has not yet been verified with a new paid live model run. Earlier live installation checks cover their recorded versions and scenarios; they do not establish the quality or cost of the multipart analysis described here.
