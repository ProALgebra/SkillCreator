import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { CuratorCore, type CoreOptions } from '../src/core.js';
import type { Principal, PackageFiles } from '../src/types.js';
import type { RpcInput, MethodName } from '../src/rpc.js';
export const owner: Principal = {
  subject: 'alice',
  tenant_id: 'tenant-a',
  workspace_ids: ['workspace-a'],
  roles: ['administrator'],
};
export const scope = { tenant_id: 'tenant-a', workspace_id: 'workspace-a' };
export const pack = (name: string, body = 'Follow the verified procedure.'): PackageFiles => ({
  'SKILL.md': `---\nname: ${name}\ndescription: A reusable ${name} procedure.\n---\n\n${body}\n`,
});
export function fixture(t: TestContext, options: Partial<CoreOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'curator-test-'));
  const core = new CuratorCore({ dataDirectory: dir, ...options });
  t.after(async () => {
    await core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    core,
    dir,
    call: (method: MethodName, input: RpcInput = {}, principal = owner) =>
      core.call(
        method,
        { ...input, idempotency_key: input.idempotency_key ?? randomUUID() },
        principal,
      ),
  };
}
export const code = (expected: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === expected;
