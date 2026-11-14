import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, owner, pack } from './helpers.js';
import type { AddressInfo } from 'node:net';
import { createBridge } from '../examples/http-bridge.mjs';

test('HTTP bridge and Python SDK preserve authorization and RPC errors', async (t) => {
  const { core } = fixture(t);
  const token = 'bridge-test-capability-0123456789';
  const bridge = createBridge(async (method: string, input: { auth?: string }) => {
    assert.equal(input.auth, token);
    return core.call(method as 'system.health', input, owner);
  });
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => bridge.close(() => resolve())));
  const url = 'http://127.0.0.1:' + (bridge.address() as AddressInfo).port;
  const denied = await fetch(url + '/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'system.health', input: {} }),
  });
  assert.equal(denied.status, 401);
  const response = await fetch(url + '/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      method: 'skills.create',
      input: { files: pack('from-python-bridge'), idempotency_key: 'bridge-create' },
    }),
  });
  assert.equal(response.status, 200);
  const created = (await response.json()) as { result: { skill_id: string } };
  assert.ok(created.result.skill_id);
  const child = spawn('python3', ['examples/valeria_client.py'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {
      ...process.env,
      CURATOR_BRIDGE_URL: url,
      CURATOR_WORKSPACE: 'workspace-a',
      SKILL_CURATOR_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => (stdout += data));
  child.stderr.on('data', (data) => (stderr += data));
  const exit = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  assert.equal(exit, 0, stderr);
  assert.equal(JSON.parse(stdout).version, '0.3.2');
});
