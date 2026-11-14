import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveLocalToken } from '../src/auth.js';
test('local service auth derives the same capability for server/TUI without storing another secret', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'curator-auth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'opencode'));
  const path = join(root, 'opencode', 'service.json');
  const password = 'test-only-existing-service-password';
  writeFileSync(path, JSON.stringify({ password }), { mode: 0o600 });
  const env = { XDG_CONFIG_HOME: root };
  const token = resolveLocalToken({ local_service_auth: true }, env);
  assert.ok(token && token.length >= 24);
  assert.notEqual(token, password);
  assert.equal(token, resolveLocalToken({ local_service_auth: true }, env));
  assert.equal(resolveLocalToken({}, env), undefined);
  assert.equal(
    resolveLocalToken(
      { local_service_auth: true },
      { ...env, SKILL_CURATOR_TOKEN: 'explicit-token' },
    ),
    'explicit-token',
  );
  if (process.platform !== 'win32') {
    chmodSync(path, 0o644);
    assert.throws(
      () => resolveLocalToken({ local_service_auth: true }, env),
      /private to their owner/,
    );
  }
});
