import type { Plugin } from '@opencode/plugin';
import { resolve } from 'node:path';
import type { CoreOptions } from './core.js';
import type { Scope } from './types.js';
import { sameScope } from './types.js';
import { ensure } from './errors.js';
import { redact } from './learning.js';

type Sessions = Pick<Plugin.Context['session'], 'list' | 'get' | 'context'>;

/** The SDK is trusted for ownership, but messages remain untrusted model input. */
export function openCodeConversations(
  sessions: Sessions,
  directory: string,
  boundScope: Scope,
  internal: (id: string) => boolean,
): NonNullable<CoreOptions['conversations']> & {
  state(sessionID: string): Promise<{ idle: boolean; child: boolean }>;
} {
  const own = (info: Awaited<ReturnType<Sessions['get']>>) =>
    resolve(info.location.directory) === resolve(directory) &&
    !internal(info.id) &&
    !info.id.startsWith('ses_curator_') &&
    info.metadata?.skill_curator_internal !== true;
  const idle = (info: Awaited<ReturnType<Sessions['get']>>) =>
    !info.time.busy || (info.time.idle ?? 0) >= info.time.busy;
  const authorize = (scope: Scope) =>
    ensure(sameScope(scope, boundScope), 'scope_violation', 'History belongs to another workspace');
  return {
    async list(scope, limit) {
      authorize(scope);
      const pages = await Promise.all([
        sessions.list({ directory, limit, order: 'desc', archived: false }),
        sessions.list({ directory, limit, order: 'desc', archived: true }),
      ]);
      return [
        ...new Map(
          pages
            .flatMap((p) => p.data)
            .filter(own)
            .map((s) => [s.id, s]),
        ).values(),
      ]
        .sort((a, b) => b.time.updated - a.time.updated)
        .slice(0, limit)
        .map((s) => ({ session_id: s.id, title: redact(s.title || s.id) }));
    },
    async read(scope, sessionID) {
      authorize(scope);
      const before = await sessions.get({ sessionID });
      ensure(own(before), 'scope_violation', 'History is outside this workspace or internal');
      ensure(
        idle(before),
        'revision_conflict',
        'Wait until the conversation finishes its response',
      );
      const messages = await sessions.context({ sessionID });
      const after = await sessions.get({ sessionID });
      ensure(
        own(after) && idle(after) && before.time.updated === after.time.updated,
        'revision_conflict',
        'Conversation changed while capturing its context; try again after the response',
      );
      ensure(messages.length > 0, 'validation_error', 'Conversation has no stored context');
      return {
        content: JSON.stringify(messages),
        ...(after.model
          ? {
              model: {
                provider: after.model.providerID,
                model: after.model.id,
                variant: after.model.variant,
              },
            }
          : {}),
      };
    },
    async state(sessionID) {
      const info = await sessions.get({ sessionID });
      ensure(own(info), 'scope_violation', 'Conversation is outside this workspace or internal');
      return { idle: idle(info) && info.outcome === 'succeeded', child: Boolean(info.parentID) };
    },
  };
}
