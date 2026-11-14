import { OpenCode } from '@opencode/client';
import { SkillCurator, CuratorClient } from 'opencode-skill-curator/rpc';
import { randomUUID } from 'node:crypto';

const opencode = OpenCode.make({ baseUrl: process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096' });
const rpc = opencode.rpc(SkillCurator);
const client = new CuratorClient(
  (method, input) => rpc[method](input),
  process.env.SKILL_CURATOR_TOKEN,
  { workspace_id: process.env.CURATOR_WORKSPACE ?? 'my-project' },
);

const list = await client.call('skills.list', { limit: 50 });
console.log(
  list.items.map((skill) => ({ id: skill.skill_id, name: skill.name, revision: skill.revision })),
);

// An explicit direct request remains local even if the caller is VALERIA.
const accepted = await client.call('curator.review', {
  execution: { mode: 'direct', max_cost_usd: 0.5 },
  idempotency_key: randomUUID(),
});
console.log(accepted);
