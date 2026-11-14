import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const version = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const archive = resolve(process.argv[2] ?? `opencode-skill-curator-${version}.tgz`);
const root = resolve('.');
const dir = mkdtempSync(join(tmpdir(), 'curator-package-'));
try {
  execFileSync('tar', ['-xf', archive, '-C', dir]);
  mkdirSync(join(dir, 'node_modules'));
  renameSync(join(dir, 'package'), join(dir, 'node_modules', 'opencode-skill-curator'));
  for (const name of ['@opencode', 'better-sqlite3', 'diff', 'yaml', 'zod'])
    symlinkSync(join(root, 'node_modules', name), join(dir, 'node_modules', name), 'dir');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  const script = `import assert from 'node:assert/strict';import plugin,{CuratorCore} from 'opencode-skill-curator/server';import {SkillCurator,methodNames} from 'opencode-skill-curator/rpc';assert.equal(plugin.id,'opencode-skill-curator');assert.equal(methodNames.length,77);assert.ok(methodNames.includes('learning.refine'));const core=new CuratorCore({dataDirectory:'./data'});try{const health=await core.call('system.health',{}, {subject:'packaged-owner',tenant_id:'test',workspace_ids:['test'],roles:['administrator']});assert.equal(health.version,${JSON.stringify(version)});}finally{await core.close();}console.log('Packed npm package exports, contract and SQLite core passed');`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: dir,
    stdio: 'inherit',
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
