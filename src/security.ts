import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Principal, Scope, Role } from './types.js';
import { ensure } from './errors.js';
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const hash = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
export const scopeSchema = z
  .object({
    tenant_id: z.string().min(1).max(200).optional(),
    workspace_id: z.string().min(1).max(200).optional(),
    directory: z.string().optional(),
  })
  .strict();
export function authorize(
  principal: Principal | undefined,
  requested: unknown,
  roles: Role[],
): Scope {
  ensure(principal?.subject, 'unauthorized', 'Authentication required');
  const parsed = scopeSchema.safeParse(requested ?? {});
  ensure(parsed.success, 'validation_error', 'Invalid scope');
  const input = parsed.data;
  ensure(
    !input.tenant_id || input.tenant_id === principal.tenant_id,
    'scope_violation',
    'Scope is not authorized',
  );
  const workspace_id = input.workspace_id ?? principal.workspace_ids[0];
  ensure(
    workspace_id && principal.workspace_ids.includes(workspace_id),
    'scope_violation',
    'Scope is not authorized',
  );
  ensure(
    principal.roles.includes('administrator') ||
      roles.some((role) => principal.roles.includes(role)),
    'forbidden',
    'Insufficient permissions',
  );
  return { tenant_id: principal.tenant_id, workspace_id };
}
