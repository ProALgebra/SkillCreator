import { Plugin, Skill as OpenCodeSkill } from '@opencode/plugin';
import { z } from 'zod';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { CuratorCore } from './core.js';
import { CuratorError, ensure } from './errors.js';
import { SkillCurator, methodNames, type RpcInput } from './rpc.js';
import { hash } from './security.js';
import { now } from './types.js';
import type { Principal, Scope, Skill } from './types.js';
import { ExecutorPreflightError, type Executor, type Job } from './jobs.js';
import { resolveLocalToken } from './auth.js';
import { openCodeConversations } from './opencode-conversations.js';
import { ConversationReview } from './conversation-review.js';
import { CuratorScheduler } from './curator-scheduler.js';
export { CuratorCore } from './core.js';
export { CuratorError } from './errors.js';
export type { Principal, Scope, Skill, Proposal, Settings } from './types.js';
const principalSchema = z
  .object({
    subject: z.string().min(1),
    tenant_id: z.string().min(1),
    workspace_ids: z.array(z.string().min(1)).min(1),
    roles: z.array(z.enum(['viewer', 'editor', 'curator', 'administrator', 'worker'])),
    worker_kind: z.enum(['valeria', 'external']).optional(),
    global_admin: z.boolean().optional(),
  })
  .strict();
const optionsSchema = z
  .object({
    data_directory: z.string().optional(),
    skill_directory: z.string().optional(),
    source_roots: z.array(z.string()).default([]),
    tenant_id: z.string().default('local'),
    workspace_id: z.string().optional(),
    token_env: z.string().default('SKILL_CURATOR_TOKEN'),
    local_service_auth: z.boolean().default(false),
    credentials: z.array(z.object({ env: z.string(), principal: principalSchema })).default([]),
  })
  .strict();
export function parseModelJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new CuratorError('validation_error', 'Executor did not return valid JSON');
  }
}

/** Read native busy/idle timestamps as well as events so reloads cannot hide an active session. */
export async function readCuratorSessionState(
  sessions: Pick<Plugin.Context['session'], 'list'>,
  directory: string,
  internal: (sessionID: string) => boolean,
) {
  const listed: Array<Awaited<ReturnType<typeof sessions.list>>['data'][number]> = [];
  let cursor: Awaited<ReturnType<typeof sessions.list>>['cursor']['next'];
  for (let page = 0; page < 100; page++) {
    const result = await sessions.list({
      directory,
      limit: 100,
      order: 'desc',
      archived: false,
      cursor: cursor ?? undefined,
    });
    listed.push(
      ...result.data.filter(
        (info) =>
          resolve(info.location.directory) === resolve(directory) &&
          !info.id.startsWith('ses_curator_') &&
          !internal(info.id) &&
          info.metadata?.skill_curator_internal !== true,
      ),
    );
    cursor = result.cursor.next;
    if (!cursor) break;
  }
  // An unexpectedly large or changing archive must not turn a partial read into an idle verdict.
  if (cursor) return { idle: false };
  const recent = listed
    .filter((info) => !info.parentID && info.model)
    .sort((a, b) => b.time.updated - a.time.updated)[0];
  return {
    idle: listed.every((info) => !info.time.busy || (info.time.idle ?? 0) >= info.time.busy),
    last_activity_at: Math.max(
      0,
      ...listed.flatMap((info) => [info.time.busy ?? 0, info.time.idle ?? 0]),
    ),
    ...(recent?.model
      ? {
          execution: {
            provider: recent.model.providerID,
            model: recent.model.id,
            ...(recent.model.variant ? { variant: recent.model.variant } : {}),
          },
        }
      : {}),
  };
}
export default Plugin.define({
  id: 'opencode-skill-curator',
  async setup(ctx) {
    const options = optionsSchema.parse(ctx.options);
    const workspace =
      options.workspace_id ?? ctx.location.workspaceID ?? hash(ctx.location.directory).slice(0, 24);
    const scope: Scope = { tenant_id: options.tenant_id, workspace_id: workspace };
    const local: Principal = {
      subject: 'local-owner',
      tenant_id: scope.tenant_id,
      workspace_ids: [scope.workspace_id],
      roles: ['administrator'],
      global_admin: true,
    };
    const sourceRoots = [
      join(ctx.location.directory, '.opencode', 'skills'),
      join(ctx.location.directory, '.agents', 'skills'),
      join(homedir(), '.config', 'opencode', 'skills'),
      join(homedir(), '.agents', 'skills'),
      ...options.source_roots,
    ].filter(existsSync);
    const bindings = [
      { token: resolveLocalToken(options), principal: local },
      ...options.credentials.map((binding) => ({
        token: process.env[binding.env],
        principal: binding.principal,
      })),
    ];
    const identities = new Map<string, Principal>();
    for (const binding of bindings) {
      const token = binding.token;
      if (token) {
        ensure(
          token.length >= 24,
          'validation_error',
          'Capability tokens must have at least 24 characters',
        );
        identities.set(hash(token), binding.principal);
      }
    }
    ensure(
      identities.size > 0,
      'unauthorized',
      'Set SKILL_CURATOR_TOKEN (24+ characters) before loading the plugin',
    );
    let core: CuratorCore;
    const conversations = openCodeConversations(ctx.session, ctx.location.directory, scope, (id) =>
      Boolean(core?.store.get('control', 'internal:' + id)),
    );
    const modelPayload = (job: Job) => {
      try {
        return core.modelPayload(job);
      } catch (error) {
        if (error instanceof CuratorError) throw new ExecutorPreflightError(error);
        throw error;
      }
    };
    const direct: Executor = async ({ job, signal }) => {
      if (job.max_cost_usd <= job.cost)
        throw new ExecutorPreflightError(
          new CuratorError('budget_exceeded', 'No provider budget remains'),
        );
      const context = modelPayload(job);
      const result = await ctx.experimental.generate.text(
        {
          prompt: JSON.stringify(context),
          model:
            job.execution.model && job.execution.provider
              ? {
                  id: job.execution.model,
                  providerID: job.execution.provider,
                  variant: job.execution.variant,
                }
              : undefined,
        },
        { signal },
      );
      // SDK 2.3 direct generation reports text only. Charge the complete reservation conservatively.
      return { output: parseModelJson(result.text), cost_usd: job.max_cost_usd - job.cost };
    };
    const session: Executor = async ({ job, signal }) => {
      if (job.max_cost_usd <= job.cost)
        throw new ExecutorPreflightError(
          new CuratorError('budget_exceeded', 'No provider budget remains'),
        );
      const context = modelPayload(job);
      // Register the chosen ID before create/prompt so event capture cannot recursively ingest it.
      const sessionID = 'ses_curator_' + job.job_id.replaceAll('-', '') + '_' + job.attempt;
      core.store.put('control', 'internal:' + sessionID, {
        ...scope,
        internal: true,
        job_id: job.job_id,
      });
      const created = await ctx.session.create(
        {
          id: sessionID,
          title: 'Skill Curator: ' + job.operation,
          metadata: { skill_curator_internal: true, job_id: job.job_id },
          model:
            job.execution.model && job.execution.provider
              ? {
                  id: job.execution.model,
                  providerID: job.execution.provider,
                  variant: job.execution.variant,
                }
              : undefined,
          permissions: [{ action: '*', resource: '*', effect: 'deny' }],
        },
        { signal },
      );
      core.store.put('control', 'internal:' + created.id, {
        ...scope,
        internal: true,
        job_id: job.job_id,
      });
      const interrupt = () => {
        void ctx.session.interrupt({ sessionID: created.id, resume: false }).catch(() => {});
      };
      signal.addEventListener('abort', interrupt, { once: true });
      try {
        await ctx.session.prompt(
          {
            sessionID: created.id,
            text: JSON.stringify(context),
            metadata: { skill_curator_internal: true },
          },
          { signal },
        );
        await ctx.session.wait({ sessionID: created.id }, { signal });
        const messages = await ctx.session.context({ sessionID: created.id }, { signal });
        const assistants = messages.filter((m) => m.type === 'assistant');
        const last = assistants.at(-1);
        ensure(last, 'validation_error', 'Internal session returned no assistant result');
        const text = last.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        const cost = assistants.every((m) => m.cost !== undefined)
          ? assistants.reduce((sum, m) => sum + (m.cost ?? 0), 0)
          : job.max_cost_usd - job.cost;
        return { output: parseModelJson(text), cost_usd: cost };
      } finally {
        signal.removeEventListener('abort', interrupt);
      }
    };
    const root = options.data_directory ?? join(ctx.location.directory, '.curator');
    core = new CuratorCore({
      dataDirectory: root,
      skillDirectory: options.skill_directory,
      executors: { direct, session },
      conversations,
      reload: () => ctx.skill.reload(),
      discover: async () => {
        const listed = await ctx.skill.list();
        core.catalog.discover(
          scope,
          local.subject,
          listed.data.map((s) => ({
            name: s.name,
            description: s.description ?? '',
            path: s.path,
            content: s.content,
          })),
          sourceRoots,
        );
      },
    });
    const transform = await ctx.skill.transform((editor) => {
      for (const entry of editor.list().filter((s) => s.id.startsWith('curator.')))
        editor.remove(entry.id);
      for (const skill of core.catalog
        .list(scope)
        .filter((s) => ['active', 'stale'].includes(s.state) && s.source === 'plugin'))
        editor.add({
          id: OpenCodeSkill.ID.make('curator.' + skill.skill_id),
          name: OpenCodeSkill.Name.make(skill.name),
          description: skill.description,
          path: OpenCodeSkill.Info.fields.path.make(
            join(core.catalog.packages.path(scope, skill.skill_id), 'SKILL.md'),
          ),
          content: skill.files['SKILL.md']!,
        });
    });
    const registration = await ctx.rpc.register(
      SkillCurator,
      Object.fromEntries(
        methodNames.map((method) => [
          method,
          async (
            input: RpcInput,
            context: {
              error: (
                code: CuratorError['code'],
                message: string,
                data: { code: CuratorError['code']; message: string },
              ) => unknown;
            },
          ) => {
            try {
              const principal = input.auth ? identities.get(hash(input.auth)) : undefined;
              ensure(principal, 'unauthorized', 'Invalid capability token');
              // OpenCode's RPC output is JsonValue: optional undefined properties must be omitted.
              return JSON.parse(JSON.stringify(await core.call(method, input, principal)));
            } catch (error) {
              const typed =
                error instanceof CuratorError
                  ? error
                  : new CuratorError('internal_error', 'Request failed');
              return context.error(typed.code, typed.message, typed.toJSON());
            }
          },
        ]),
      ) as unknown as Parameters<typeof ctx.rpc.register<typeof SkillCurator>>[1],
    );
    // SDK 2.3 does not expose caller identity or filtered event subscriptions. Do not broadcast tenant data.
    // Authenticated events.replay is the authoritative event transport for external clients.
    const controller = new AbortController();
    const conversationReview = new ConversationReview(core.store, scope);
    const curatorScheduler = new CuratorScheduler(core.store, scope);
    const toolCapture = await ctx.tool.hook('execute.after', (event) => {
      if (
        event.sessionID.startsWith('ses_curator_') ||
        core.store.get('control', 'internal:' + event.sessionID)
      )
        return;
      curatorScheduler.activity(event.sessionID, 'tool-after:' + String(event.id));
      conversationReview.activity(event.sessionID, String(event.id));
      if (core.settings.get(scope).settings.conversation_review.enabled) return;
      if (event.status !== 'completed') return;
      const input = event.input as { command?: unknown; cmd?: unknown } | null;
      const command =
        typeof input?.command === 'string'
          ? input.command
          : typeof input?.cmd === 'string'
            ? input.cmd
            : '';
      const metadata = event.result.metadata as Record<string, unknown> | undefined;
      const exit = metadata?.exitCode ?? metadata?.exit_code ?? metadata?.exit;
      const verification =
        /\b(?:test|pytest|vitest|jest|cargo\s+test|go\s+test|unittest)\b/.test(command) &&
        exit === 0;
      if (!verification) return;
      core.learning.ingest(scope, 'opencode', {
        source_instance: 'opencode:' + hash(ctx.location.directory),
        session_id: event.sessionID,
        stage_id: 'tool:' + event.id,
        content: JSON.stringify({ command, result: event.result }),
        verified: true,
        source_refs: [String(event.id)],
      });
    });
    const capture = async () => {
      for await (const event of ctx.event.subscribe({
        types: [
          'session.execution.started',
          'session.execution.succeeded',
          'session.execution.failed',
          'session.execution.interrupted',
          'session.tool.called',
          'session.skill.activated',
        ],
        signal: controller.signal,
      })) {
        if (event.location?.directory !== ctx.location.directory) continue;
        const sessionID = event.data.sessionID;
        if (
          sessionID.startsWith('ses_curator_') ||
          core.store.get('control', 'internal:' + sessionID)
        )
          continue;
        curatorScheduler.activity(sessionID, event.type + ':' + String(event.id));
        if (event.type === 'session.tool.called') continue;
        if (event.type === 'session.skill.activated') {
          const skill = core.catalog.list(scope).find((s) => s.name === event.data.name);
          if (skill)
            core.catalog.recordUsage(scope, 'opencode', skill.skill_id, 'session.skill.activated');
          continue;
        }
        if (event.type === 'session.execution.started') {
          conversationReview.sessionStarted(sessionID, String(event.id));
          continue;
        }
        if (event.type !== 'session.execution.succeeded') {
          conversationReview.interrupted(sessionID, String(event.id));
          continue;
        }
        conversationReview.completed(sessionID, String(event.id));
        if (core.settings.get(scope).settings.conversation_review.enabled) continue;
        // Durable backlog marker only: heavy history reads happen on the scheduled tick.
        const key = 'capture:' + hash([scope, sessionID, event.id]);
        core.store.put('control', key, {
          ...scope,
          key,
          session_id: sessionID,
          created_at: now(),
          processed: false,
        });
      }
    };
    void capture().catch(() => {
      if (!controller.signal.aborted)
        core.store.emit('health.changed', scope, 'opencode', 'capture', { status: 'disconnected' });
    });
    let ticking = false;
    const tick = async () => {
      if (ticking || controller.signal.aborted) return;
      ticking = true;
      try {
        const settings = core.settings.get(scope).settings;
        const paused = core.store.get<{ all: boolean; learning?: boolean; curator?: boolean }>(
          'control',
          'pause:' + hash(scope),
        );
        if (paused?.all) return;
        const backlog = core.store
          .all<{
            key: string;
            tenant_id: string;
            workspace_id: string;
            session_id: string;
            created_at: string;
            processed: boolean;
          }>('control')
          .filter(
            (r) =>
              r.key?.startsWith('capture:') &&
              r.tenant_id === scope.tenant_id &&
              r.workspace_id === scope.workspace_id &&
              !r.processed,
          );
        for (const item of backlog.slice(0, 10)) {
          if (settings.conversation_review.enabled) break;
          if (
            Date.now() - Date.parse(item.created_at) <
            Math.max(settings.auto_learning.min_age_sec, settings.auto_learning.debounce_sec) * 1000
          )
            continue;
          try {
            const messages = await ctx.session.context({ sessionID: item.session_id });
            core.learning.ingest(scope, 'opencode', {
              source_instance: 'opencode:' + hash(ctx.location.directory),
              session_id: item.session_id,
              stage_id: item.key,
              content: JSON.stringify(messages),
              verified: false,
            });
            core.store.put('control', item.key, { ...item, processed: true });
          } catch {
            core.store.emit('health.changed', scope, 'opencode', 'capture', {
              status: 'history_unavailable',
            });
          }
        }
        await conversationReview.drain({
          settings,
          paused: Boolean(paused?.learning),
          readState: (sessionID) => conversations.state(sessionID),
          run: async (sessionID, idempotencyKey) => {
            const configured = settings.conversation_review;
            return (await core.call(
              'learning.refine',
              {
                session_ids: [sessionID],
                idempotency_key: idempotencyKey,
                execution:
                  configured.provider && configured.model
                    ? {
                        provider: configured.provider,
                        model: configured.model,
                        ...(configured.variant ? { variant: configured.variant } : {}),
                      }
                    : undefined,
              },
              local,
            )) as { job_id: string };
          },
        });
        // The old verified-fragment trigger remains available when conversation review is disabled.
        if (
          !settings.conversation_review.enabled &&
          settings.auto_learning.enabled &&
          !paused?.learning &&
          settings.auto_learning.on_session_end &&
          !settings.auto_learning.quiet_hours.includes(new Date().getUTCHours())
        ) {
          const ready = core.learning.sessions(scope).filter((s) => s.verified && !s.processed);
          if (ready.length >= settings.auto_learning.every_n_sessions) {
            try {
              await core.call(
                'learning.run',
                {
                  session_ids: ready.map((s) => s.session_id),
                  idempotency_key: 'auto:' + hash(ready.map((s) => s.id)),
                },
                local,
              );
            } catch (error) {
              if (
                !(
                  error instanceof CuratorError &&
                  ['executor_unavailable', 'budget_exceeded'].includes(error.code)
                )
              )
                throw error;
            }
          }
        }
        await curatorScheduler.drain({
          settings,
          paused: Boolean(paused?.curator),
          readState: () =>
            readCuratorSessionState(ctx.session, ctx.location.directory, (sessionID) =>
              Boolean(core.store.get('control', 'internal:' + sessionID)),
            ),
          lifecycle: (idempotencyKey) =>
            core.call('curator.lifecycle_run', { idempotency_key: idempotencyKey }, local),
          optimize: async (idempotencyKey, execution) =>
            (await core.call(
              'curator.optimize',
              { idempotency_key: idempotencyKey, execution },
              local,
            )) as { run_id: string; jobs: Array<{ job_id: string }> },
        });
        core.learning.prune(scope);
        await core.tick();
      } catch {
        if (!controller.signal.aborted)
          core.store.emit('health.changed', scope, 'opencode', 'scheduler', { status: 'failed' });
      } finally {
        ticking = false;
      }
    };
    await core.options.discover?.();
    await ctx.skill.reload();
    const timer = setInterval(() => void tick(), 1000);
    timer.unref();
    return async () => {
      controller.abort();
      clearInterval(timer);
      await toolCapture.dispose();
      await registration.dispose();
      await transform.dispose();
      await core.close();
    };
  },
});
