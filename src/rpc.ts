import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';
import { errorCodes, type ErrorCode } from './errors.js';
import { scopeSchema } from './security.js';
export const methodNames = [
  'system.health',
  'system.status',
  'system.capabilities',
  'system.pause',
  'system.resume',
  'system.shutdown_work',
  'settings.get',
  'settings.patch',
  'settings.set_publication_mode',
  'settings.validate',
  'settings.reset',
  'manager.snapshot',
  'manager.refresh',
  'skills.list',
  'skills.get',
  'skills.search',
  'skills.create',
  'skills.update',
  'skills.rename',
  'skills.clone',
  'skills.merge.preview',
  'skills.split.preview',
  'skills.archive',
  'skills.restore',
  'skills.pin',
  'skills.unpin',
  'skills.lock',
  'skills.unlock',
  'skills.adopt',
  'skills.unadopt',
  'skills.history',
  'skills.diff',
  'skills.rollback',
  'skills.import',
  'skills.export',
  'skills.usage',
  'skills.dependencies',
  'learning.run',
  'learning.refine',
  'learning.sessions',
  'learning.ingest',
  'learning.candidates',
  'learning.backfill',
  'curator.review',
  'curator.analyze_duplicates',
  'curator.lifecycle_run',
  'curator.update',
  'proposals.list',
  'proposals.get',
  'proposals.validate',
  'proposals.approve',
  'proposals.reject',
  'proposals.apply',
  'proposals.cancel',
  'jobs.list',
  'jobs.get',
  'jobs.run',
  'jobs.pause',
  'jobs.resume',
  'jobs.cancel',
  'jobs.retry',
  'jobs.progress',
  'jobs.logs',
  'jobs.lease',
  'jobs.heartbeat',
  'jobs.complete',
  'jobs.fail',
  'executors.list',
  'executors.status',
  'executors.test',
  'executors.set_policy',
  'stats.overview',
  'stats.learning',
  'stats.skills',
  'stats.costs',
  'audit.list',
  'events.replay',
] as const;
export type MethodName = (typeof methodNames)[number];
export const eventNames = [
  'skill.created',
  'skill.updated',
  'skill.archived',
  'skill.restored',
  'skill.merged',
  'skill.locked',
  'skill.used',
  'proposal.created',
  'proposal.validated',
  'proposal.approved',
  'proposal.applied',
  'proposal.rejected',
  'proposal.cancelled',
  'job.created',
  'job.started',
  'job.progress',
  'job.waiting_executor',
  'job.completed',
  'job.failed',
  'job.cancelled',
  'settings.changed',
  'manager.refreshed',
  'health.changed',
  'learning.ingested',
  'learning.candidate_created',
] as const;
export const executionSchema = z
  .object({
    mode: z.enum(['direct', 'session', 'valeria', 'external', 'auto']).optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    variant: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_iterations: z.number().int().positive().optional(),
    timeout_sec: z.number().positive().max(86400).optional(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    max_cost_usd: z.number().nonnegative().optional(),
    max_parallel: z.number().int().positive().optional(),
    fallback_policy: z.enum(['before_accept', 'never']).optional(),
    approval_mode: z.enum(['manual', 'auto']).optional(),
  })
  .strict();
export const inputSchema = z
  .object({
    auth: z.string().min(1).optional(),
    scope: scopeSchema.optional(),
    settings_level: z.enum(['workspace', 'tenant', 'global']).optional(),
    publication_mode: z.enum(['manual', 'auto']).optional(),
    idempotency_key: z.string().min(1).max(240).optional(),
    correlation_id: z.string().max(240).optional(),
    dry_run: z.boolean().optional(),
    confirm_stopped: z.boolean().optional(),
    skill_id: z.string().optional(),
    skill_ids: z.array(z.string()).max(100).optional(),
    skill_scope: z.enum(['workspace', 'global']).optional(),
    proposal_id: z.string().optional(),
    job_id: z.string().optional(),
    expected_revision: z.number().int().nonnegative().optional(),
    revision: z.number().int().positive().optional(),
    target_revision: z.number().int().positive().optional(),
    from_revision: z.number().int().positive().optional(),
    to_revision: z.number().int().positive().optional(),
    name: z.string().optional(),
    files: z.record(z.string(), z.string()).optional(),
    parts: z.array(z.record(z.string(), z.string())).optional(),
    reason: z.string().max(4000).optional(),
    query: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
    cursor: z.string().max(500).optional(),
    filters: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional(),
    sort: z.enum(['name', 'updated_at', 'use_count']).optional(),
    execution: executionSchema.optional(),
    operation: z.enum(['learning', 'review', 'merge', 'update']).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    session_ids: z.array(z.string()).max(1000).optional(),
    transcripts: z.array(z.unknown()).max(100).optional(),
    transcript: z.unknown().optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
    subsystem: z.enum(['all', 'learning', 'curator']).optional(),
    worker_kind: z.enum(['valeria', 'external']).optional(),
    worker_id: z.string().optional(),
    lease_token: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
    result: z.unknown().optional(),
    error: z.string().max(4000).optional(),
    cost_usd: z.number().nonnegative().optional(),
  })
  .strict();
export type RpcInput = z.infer<typeof inputSchema>;
const errorSchema = z.object({ code: z.enum(errorCodes), message: z.string() });
const errors = Object.fromEntries(errorCodes.map((code) => [code, errorSchema])) as Record<
  ErrorCode,
  typeof errorSchema
>;
const envelope = z
  .object({
    request_id: z.string(),
    correlation_id: z.string(),
    created_at: z.string(),
    status: z.string(),
  })
  .passthrough();
const skillRecord = z.object({
  skill_id: z.string(),
  name: z.string(),
  description: z.string(),
  tenant_id: z.string(),
  workspace_id: z.string(),
  scope: z.enum(['global', 'workspace', 'external']),
  owner: z.enum(['plugin', 'user', 'third_party', 'unknown']),
  management_policy: z.enum(['managed', 'manual', 'readonly']),
  state: z.enum(['active', 'stale', 'archived', 'superseded']),
  pinned: z.boolean(),
  locked: z.boolean(),
  revision: z.number(),
  files: z.record(z.string(), z.string()),
  package_hash: z.string(),
  content_hash: z.string(),
  source: z.string(),
  source_path: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  last_used_at: z.string().optional(),
  use_count: z.number(),
  view_count: z.number(),
  patch_count: z.number(),
  source_session_ids: z.array(z.string()),
  validation_status: z.string(),
  risk_level: z.string(),
  tags: z.array(z.string()),
  replaced_by: z.string().optional(),
});
const proposalRecord = z
  .object({
    proposal_id: z.string(),
    revision: z.number(),
    status: z.enum(['pending', 'approved', 'rejected', 'applied', 'cancelled']),
    diff: z.string(),
    rationale: z.string(),
    source_refs: z.array(z.string()),
    risk_level: z.string(),
    operation: z.string(),
    automatic: z.boolean(),
  })
  .passthrough();
const jobRecord = z
  .object({
    job_id: z.string(),
    operation: z.string(),
    executor_mode: z.enum(['direct', 'session', 'valeria', 'external']),
    status: z.string(),
    progress: z.number(),
    attempt: z.number(),
    cost: z.number(),
    proposal_ids: z.array(z.string()),
  })
  .passthrough();
const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), cursor: z.string().nullable(), total: z.number() });
const genericOutputs = Object.fromEntries(methodNames.map((m) => [m, envelope])) as Record<
  MethodName,
  typeof envelope
>;
const jobOrPreview = z.union([
  envelope.merge(jobRecord),
  envelope.extend({
    operation: z.string(),
    executor_mode: z.string(),
    potential_changes: z.array(z.unknown()),
    files_written: z.literal(false),
  }),
]);
export const outputSchemas = {
  ...genericOutputs,
  'skills.get': envelope.merge(skillRecord),
  'skills.create': envelope.merge(skillRecord),
  'skills.import': envelope.merge(skillRecord),
  'skills.update': envelope.merge(skillRecord),
  'skills.rename': envelope.merge(skillRecord),
  'skills.clone': envelope.merge(skillRecord),
  'skills.archive': envelope.merge(skillRecord),
  'skills.restore': envelope.merge(skillRecord),
  'skills.pin': envelope.merge(skillRecord),
  'skills.unpin': envelope.merge(skillRecord),
  'skills.lock': envelope.merge(skillRecord),
  'skills.unlock': envelope.merge(skillRecord),
  'skills.adopt': envelope.merge(skillRecord),
  'skills.unadopt': envelope.merge(skillRecord),
  'skills.rollback': envelope.merge(skillRecord),
  'skills.list': envelope.merge(page(skillRecord)),
  'skills.search': envelope.merge(page(skillRecord)),
  'proposals.get': envelope.merge(proposalRecord),
  'proposals.list': envelope.merge(page(proposalRecord)),
  'jobs.get': envelope.merge(jobRecord),
  'jobs.list': envelope.merge(page(jobRecord)),
  'settings.get': envelope.extend({
    revision: z.number(),
    settings: z.record(z.string(), z.unknown()),
  }),
  'settings.set_publication_mode': envelope.extend({
    revision: z.number(),
    settings: z.record(z.string(), z.unknown()),
  }),
  'learning.run': jobOrPreview,
  'learning.refine': jobOrPreview,
  'learning.sessions': envelope.merge(
    page(z.object({ session_id: z.string(), title: z.string() })),
  ),
  'curator.review': jobOrPreview,
  'curator.update': jobOrPreview,
  'jobs.run': jobOrPreview,
};
type Methods = {
  [M in MethodName]: {
    input: typeof inputSchema;
    output: (typeof outputSchemas)[M];
    errors: typeof errors;
  };
};
const methods = Object.fromEntries(
  methodNames.map((name) => [name, { input: inputSchema, output: outputSchemas[name], errors }]),
) as Methods;
export const SkillCurator = Rpc.define({
  id: 'skill-curator.v1',
  methods,
  events: Object.fromEntries(
    eventNames.map((name) => [
      name,
      {
        schema: z.object({
          event_id: z.string(),
          occurred_at: z.string(),
          tenant_id: z.string(),
          workspace_id: z.string(),
          type: z.string(),
          actor: z.string(),
          correlation_id: z.string(),
          entity_id: z.string(),
          entity_revision: z.number().optional(),
          details: z.record(z.string(), z.unknown()),
        }),
      },
    ]),
  ),
});
export type RpcTransport = (method: MethodName, input: RpcInput) => Promise<unknown>;
export class CuratorClient {
  constructor(
    private transport: RpcTransport,
    private auth?: string,
    private scope?: RpcInput['scope'],
  ) {}
  async call<M extends MethodName>(
    method: M,
    input: RpcInput = {},
  ): Promise<z.output<(typeof outputSchemas)[M]>> {
    const value = await this.transport(method, {
      ...input,
      scope: input.scope ?? this.scope,
      auth: this.auth,
    });
    return outputSchemas[method].parse(value) as z.output<(typeof outputSchemas)[M]>;
  }
}
export type { Scope, Principal, Skill, Proposal, Settings, Execution } from './types.js';
