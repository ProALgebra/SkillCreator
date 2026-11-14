// Explicit live integration check: create a dedicated conversation, review it, and cancel proposals.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';
import { SkillCurator } from '../dist/rpc.js';
import { resolveLocalToken } from '../dist/auth.js';

const endpoint = await Service.discover();
assert.ok(endpoint, 'Start the local OpenCode service');
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
const rpc = client.rpc(SkillCurator);
const location = { directory: process.cwd() };
const auth = resolveLocalToken({ local_service_auth: true });
const call = (method, input = {}) =>
  rpc[method]({ ...input, auth }, { location, signal: AbortSignal.timeout(20000) });
const mutate = (method, input = {}) => call(method, { ...input, idempotency_key: randomUUID() });
const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? fallback : process.argv[index + 1];
};
const provider = arg('--provider', 'deepseek');
const model = arg('--model-id', 'deepseek-flash');
const mode = arg('--mode', 'direct');
assert.ok(['direct', 'session'].includes(mode));
const settings = await call('settings.get');
assert.equal(settings.settings.approval.mode, 'manual', 'Run this check with manual approval');
let source;
let job;
try {
  source = await client.session.create({
    location,
    title: 'Skill Curator conversation review check',
    model: { providerID: provider, id: model },
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
  });
  await client.session.prompt({
    sessionID: source.id,
    text: 'Это запись реально проверенного процесса в проекте. При обновлении локального плагина OpenCode 2.3 обычный reload не заменял транзитивные модули внутри node_modules. Решение: собрать и проверить пакет; распаковать его в отдельный releases/<version>-<hash> вне node_modules; сохранить прежнюю конфигурацию; обновить путь пакета в серверной и CLI-конфигурации, сохранив остальные плагины; выполнить opencode reload; проверить RPC system.health и видимость навыка через native skill.list. После переноса в releases новая сборка была загружена, health и skill lifecycle проверки прошли. Этот процесс полезен при повторных локальных обновлениях плагинов. Не выполняй никаких инструментов. Ответь только: Принято.',
  });
  await client.experimental.session.wait(
    { sessionID: source.id },
    { signal: AbortSignal.timeout(60000) },
  );
  const history = await call('learning.sessions', { limit: 100 });
  assert.ok(
    history.items.some((s) => s.session_id === source.id),
    'New conversation must appear in history',
  );
  const preview = await call('learning.refine', {
    session_ids: [source.id],
    dry_run: true,
    execution: { mode },
  });
  assert.equal(preview.files_written, false);
  job = await mutate('learning.refine', {
    session_ids: [source.id],
    reason:
      'Extract the reusable local plugin upgrade workflow from this conversation, including the failed approach and validation. Use a new short skill name if no editable existing skill covers it.',
    execution: { mode, max_cost_usd: 0.01, timeout_sec: 60 },
  });
  assert.equal(
    job.execution.provider,
    provider,
    'Review should inherit the source conversation provider',
  );
  assert.equal(job.execution.model, model, 'Review should inherit the source conversation model');
  const deadline = Date.now() + 75000;
  while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    job = await call('jobs.get', { job_id: job.job_id });
  }
  console.log(
    'Conversation review:',
    JSON.stringify({
      mode,
      session_id: source.id,
      job_id: job.job_id,
      status: job.status,
      proposals: job.proposal_ids.length,
      error: job.error,
    }),
  );
  assert.equal(job.status, 'completed');
  if (process.argv.includes('--require-proposal'))
    assert.ok(
      job.proposal_ids.length > 0,
      'The model returned no reusable proposal for this conversation',
    );
  for (const id of job.proposal_ids) {
    const proposal = await call('proposals.get', { proposal_id: id });
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.operation, 'create');
    assert.ok(proposal.source_refs.some((ref) => job.source_refs.includes(ref)));
    assert.ok(proposal.changes[0].files['SKILL.md'].includes('Conversation evidence'));
  }
  console.log(
    'History, preview, inherited model and review result passed; pending proposals checked when present',
  );
} finally {
  if (job) {
    const latest = await call('jobs.get', { job_id: job.job_id });
    for (const id of latest.proposal_ids) {
      const proposal = await call('proposals.get', { proposal_id: id });
      if (proposal.status === 'pending')
        await mutate('proposals.cancel', { proposal_id: id, expected_revision: proposal.revision });
    }
  }
  if (source) await client.session.update({ sessionID: source.id, archived: true });
  console.log('Test conversation archived; test proposals cancelled; audit retained');
}
