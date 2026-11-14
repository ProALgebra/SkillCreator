import {
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  realpathSync,
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { resolve, relative, dirname, join, posix, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import type { PackageFiles, Scope, Skill } from './types.js';
import { ensure, CuratorError } from './errors.js';
import { hash } from './security.js';
const maxBytes = 20 * 1024 * 1024;
export function safeRelative(path: string): void {
  ensure(
    path.length > 0 &&
      path.length < 500 &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      !isAbsolute(path) &&
      path === posix.normalize(path) &&
      !path.split('/').some((p) => p === '..' || p === '.' || p.startsWith('.curator')),
    'validation_error',
    'Unsafe package path',
  );
}
export function decodeFile(value: string): Buffer {
  return value.startsWith('base64:') ? Buffer.from(value.slice(7), 'base64') : Buffer.from(value);
}
export function encodeFile(value: Buffer): string {
  const text = value.toString('utf8');
  return Buffer.from(text).equals(value) && !text.startsWith('base64:')
    ? text
    : 'base64:' + value.toString('base64');
}
export function metadata(files: PackageFiles): {
  name: string;
  description: string;
  tags: string[];
} {
  const content = files['SKILL.md'];
  ensure(
    content && !content.startsWith('base64:'),
    'validation_error',
    'A UTF-8 SKILL.md is required',
  );
  const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  ensure(front, 'validation_error', 'SKILL.md requires YAML front matter');
  let meta: Record<string, unknown>;
  try {
    meta = parse(front[1]!) as Record<string, unknown>;
  } catch {
    throw new CuratorError('validation_error', 'Invalid YAML front matter');
  }
  ensure(
    meta &&
      typeof meta.name === 'string' &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) &&
      meta.name.length <= 64,
    'validation_error',
    'Invalid skill name',
  );
  ensure(
    typeof meta.description === 'string' &&
      meta.description.trim().length > 0 &&
      meta.description.length <= 2048,
    'validation_error',
    'Invalid description',
  );
  return {
    name: meta.name,
    description: meta.description,
    tags: Array.isArray(meta.tags)
      ? meta.tags.filter((v): v is string => typeof v === 'string')
      : [],
  };
}
export function renamePackage(files: PackageFiles, name: string): PackageFiles {
  const next = { ...files };
  const content = next['SKILL.md']!;
  const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)!;
  next['SKILL.md'] =
    '---\n' + stringify({ ...parse(front[1]!), name }) + '---\n' + content.slice(front[0].length);
  return next;
}
export function validatePackage(
  files: PackageFiles,
  secretCheck: (s: string) => boolean = () => false,
): void {
  ensure(
    files && typeof files === 'object' && !Array.isArray(files),
    'validation_error',
    'Invalid package',
  );
  const entries = Object.entries(files);
  ensure(entries.length <= 500, 'validation_error', 'Too many package files');
  let size = 0;
  for (const [path, value] of entries) {
    safeRelative(path);
    ensure(typeof value === 'string', 'validation_error', 'File content must be a string');
    size += decodeFile(value).length;
    ensure(size <= maxBytes, 'validation_error', 'Package exceeds size limit');
    ensure(
      !secretCheck(decodeFile(value).toString('utf8')),
      'validation_error',
      'Sensitive content is not permitted',
    );
    for (const other of Object.keys(files))
      ensure(
        !other.startsWith(path + '/'),
        'validation_error',
        'A package path is both a file and a directory',
      );
    if (!value.startsWith('base64:') && /\.(md|mdx)$/.test(path))
      for (const match of value.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
        const link = match[1]!;
        if (/^[a-z]+:|^#|^\/\//i.test(link)) continue;
        const target = posix.normalize(
          posix.join(posix.dirname(path), decodeURIComponent(link.split('#')[0]!)),
        );
        safeRelative(target);
        ensure(
          files[target] !== undefined || Object.keys(files).some((p) => p.startsWith(target + '/')),
          'validation_error',
          'Missing package dependency: ' + target,
        );
      }
  }
  metadata(files);
}
export class PackageStore {
  readonly root: string;
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
    this.check(this.root);
  }
  path(scope: Scope, id: string): string {
    return join(
      this.root,
      hash({ tenant_id: scope.tenant_id, workspace_id: scope.workspace_id }).slice(0, 24),
      id,
    );
  }
  check(path: string): void {
    const absolute = resolve(path);
    ensure(
      absolute === this.root ||
        (!relative(this.root, absolute).startsWith('..') &&
          !isAbsolute(relative(this.root, absolute))),
      'scope_violation',
      'Package path is outside the allowed root',
    );
    const parts = relative(this.root, absolute).split('/').filter(Boolean);
    let current = this.root;
    ensure(!lstatSync(current).isSymbolicLink(), 'validation_error', 'Symlink root rejected');
    for (const part of parts) {
      current = join(current, part);
      if (!existsSync(current)) {
        try {
          lstatSync(current);
        } catch {
          continue;
        }
      }
      const stat = lstatSync(current);
      ensure(
        !stat.isSymbolicLink() && (!stat.isFile() || stat.nlink === 1),
        'validation_error',
        'Symlinks and hardlinks are not allowed',
      );
    }
  }
  read(path: string, allowedRoots: string[] = [this.root]): PackageFiles {
    const absolute = resolve(path);
    const root = allowedRoots
      .map((r) => realpathSync(r))
      .find(
        (r) =>
          absolute === r ||
          (!relative(r, absolute).startsWith('..') && !isAbsolute(relative(r, absolute))),
      );
    ensure(root, 'scope_violation', 'Source path is not allowed');
    let current = root;
    for (const part of relative(root, absolute).split('/').filter(Boolean)) {
      current = join(current, part);
      ensure(!lstatSync(current).isSymbolicLink(), 'validation_error', 'Source symlink rejected');
    }
    const files: PackageFiles = {};
    let bytes = 0;
    const walk = (dir: string) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, item.name);
        const stat = lstatSync(file);
        ensure(
          !stat.isSymbolicLink() && (!stat.isFile() || stat.nlink === 1),
          'validation_error',
          'Source links rejected',
        );
        if (item.isDirectory()) walk(file);
        else {
          ensure(item.isFile(), 'validation_error', 'Special files rejected');
          bytes += stat.size;
          ensure(
            bytes <= maxBytes && Object.keys(files).length < 500,
            'validation_error',
            'Package exceeds limits',
          );
          const key = relative(absolute, file).split('\\').join('/');
          safeRelative(key);
          files[key] = encodeFile(readFileSync(file));
        }
      }
    };
    walk(absolute);
    return files;
  }
  write(skill: Skill): void {
    const target = this.path(skill, skill.skill_id);
    this.check(target);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (skill.state === 'archived' || skill.state === 'superseded') {
      this.remove(skill);
      return;
    }
    const stage = target + '.stage-' + randomUUID();
    const backup = target + '.backup';
    this.check(stage);
    this.check(backup);
    mkdirSync(stage, { mode: 0o700 });
    try {
      for (const [path, value] of Object.entries(skill.files)) {
        safeRelative(path);
        const file = join(stage, path);
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const fd = openSync(file, 'wx', 0o600);
        try {
          writeFileSync(fd, decodeFile(value));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      if (existsSync(backup)) {
        this.read(backup);
        rmSync(backup, { recursive: true });
      }
      if (existsSync(target)) {
        this.read(target);
        renameSync(target, backup);
      }
      renameSync(stage, target);
      rmSync(backup, { recursive: true, force: true });
      const dirfd = openSync(dirname(target), 'r');
      try {
        fsyncSync(dirfd);
      } finally {
        closeSync(dirfd);
      }
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
      throw error;
    }
  }
  remove(skill: Skill): void {
    const target = this.path(skill, skill.skill_id);
    this.check(target);
    if (existsSync(target)) this.read(target);
    rmSync(target, { recursive: true, force: true });
  }
  diskHash(skill: Skill): string | undefined {
    const path = this.path(skill, skill.skill_id);
    this.check(path);
    return existsSync(path) ? hash(this.read(path)) : undefined;
  }
}
