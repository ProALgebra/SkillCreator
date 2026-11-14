import { createHmac } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensure, CuratorError } from './errors.js';

export interface LocalAuthOptions {
  token_env?: string;
  local_service_auth?: boolean;
}

/** Derive a plugin-only capability without persisting a second plaintext secret. */
export function resolveLocalToken(
  options: LocalAuthOptions,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env[options.token_env ?? 'SKILL_CURATOR_TOKEN'];
  if (configured) return configured;
  if (!options.local_service_auth) return undefined;
  const path = join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode', 'service.json');
  try {
    const stat = lstatSync(path);
    ensure(
      stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
      'unauthorized',
      'Invalid local service credential file',
    );
    if (process.platform !== 'win32')
      ensure(
        (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.(),
        'unauthorized',
        'Local service credentials must be private to their owner',
      );
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const password =
      value && typeof value === 'object' && 'password' in value ? value.password : undefined;
    ensure(
      typeof password === 'string' && password.length >= 24,
      'unauthorized',
      'Local service credentials are unavailable',
    );
    return createHmac('sha256', password)
      .update('opencode-skill-curator/local-capability/v1')
      .digest('base64url');
  } catch (error) {
    if (error instanceof CuratorError) throw error;
    throw new CuratorError('unauthorized', 'Local service credentials are unavailable');
  }
}
