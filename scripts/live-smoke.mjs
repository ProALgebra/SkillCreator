// Explicit opt-in integration check against the user's running local OpenCode.
// Creates only one temporary skill, archives it in finally, and never logs credentials.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { SkillCurator } from '../dist/rpc.js';
import { resolveLocalToken } from '../dist/auth.js';

const endpoint = await Service.discover();
assert.ok(endpoint, 'Start the local OpenCode service first');
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
const rpc = client.rpc(SkillCurator);
const location = { directory: process.cwd() };
const auth = resolveLocalToken({ local_service_auth: true });
assert.ok(auth, 'No local capability available');
const call = (method, input = {}) =>
  rpc[method]({ ...input, auth }, { location, signal: AbortSignal.timeout(20000) });
const mutate = (method, input = {}) => call(method, { ...input, idempotency_key: randomUUID() });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const argument = (flag) => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
};
const visible = async (name) => {
  const listed = await client.skill.list({ location });
  const items = Array.isArray(listed) ? listed : listed.data;
  return items.some((skill) => skill.name === name);
};
let skill;
try {
  const health = await call('system.health');
  assert.equal(health.healthy, true);
  console.log('Server health:', health.version, health.storage_driver);
  await assert.rejects(
    () => rpc['system.health']({}, { location }),
    (error) => error.type?.endsWith('unauthorized') || error.data?.code === 'unauthorized',
  );
  await assert.rejects(() => call('skills.list', { scope: { tenant_id: 'forbidden' } }));
  console.log('Unauthenticated and cross-tenant requests rejected');
  const name = 'curator-install-check-' + Date.now();
  skill = await mutate('skills.create', {
    files: {
      'SKILL.md': `---\nname: ${name}\ndescription: Temporary integration check of the Skill Curator installation.\n---\n\nUse only for installation checks. Report that the check completed.\n`,
    },
  });
  assert.equal(await visible(name), true);
  const listed = await call('skills.list', { query: name });
  assert.ok(listed.items.some((item) => item.skill_id === skill.skill_id));
  console.log('Created skill visible through native OpenCode skill.list:', name);
  skill = await mutate('skills.archive', {
    skill_id: skill.skill_id,
    expected_revision: skill.revision,
  });
  assert.equal(await visible(name), false);
  skill = await mutate('skills.restore', {
    skill_id: skill.skill_id,
    expected_revision: skill.revision,
  });
  assert.equal(await visible(name), true);
  console.log('Archive/restore updates native skill visibility without restart');
  if (process.argv.includes('--model')) {
    const { data: configured } = await client.model.default({ location });
    const model = {
      providerID: argument('--provider') ?? configured.providerID,
      id: argument('--model-id') ?? configured.id,
    };
    console.log('Configured model:', model.providerID, model.id);
    for (const mode of ['direct', 'session']) {
      const submitted = await mutate('executors.test', {
        skill_ids: [skill.skill_id],
        execution: {
          mode,
          provider: model.providerID,
          model: model.id,
          max_cost_usd: 0.01,
          timeout_sec: 45,
        },
      });
      let job = submitted;
      const deadline = Date.now() + 65000;
      while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
        await sleep(1000);
        job = await call('jobs.get', { job_id: job.job_id });
      }
      console.log(
        'Executor result:',
        JSON.stringify({
          mode,
          job_id: job.job_id,
          status: job.status,
          proposal_count: job.proposal_ids.length,
          error: job.error,
        }),
      );
      assert.equal(job.status, 'completed', mode + ' executor did not complete');
      assert.equal(job.proposal_ids.length, 0, 'Test executor must not publish proposals');
    }
  }
  console.log('Live integration check passed');
} catch (error) {
  console.error('Live integration check failed:', error.message ?? error.type ?? 'Unknown error');
  process.exitCode = 1;
} finally {
  if (skill) {
    const current = await call('skills.get', { skill_id: skill.skill_id });
    if (current.state !== 'archived')
      await mutate('skills.archive', {
        skill_id: current.skill_id,
        expected_revision: current.revision,
      });
    assert.equal(await visible(skill.name), false);
    console.log('Temporary skill archived; audit history retained');
  }
}
