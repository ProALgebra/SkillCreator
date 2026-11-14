import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

// This is this adapter's /rpc endpoint, not an assumed OpenCode HTTP route.
export function createBridge(transport, { maxBytes = 2 * 1024 * 1024 } = {}) {
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const send = (status, value) => {
      response.statusCode = status;
      response.end(JSON.stringify(value));
    };
    if (request.method !== 'POST' || request.url !== '/rpc')
      return send(404, { error: { code: 'not_found', message: 'Unknown bridge endpoint' } });
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length < 31)
      return send(401, { error: { code: 'unauthorized', message: 'Bearer capability required' } });
    if (!request.headers['content-type']?.startsWith('application/json'))
      return send(415, { error: { code: 'validation_error', message: 'JSON content required' } });
    let size = 0;
    const parts = [];
    try {
      for await (const part of request) {
        size += part.length;
        if (size > maxBytes) {
          send(413, { error: { code: 'validation_error', message: 'Request too large' } });
          return;
        }
        parts.push(part);
      }
      let envelope;
      try {
        envelope = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        return send(400, { error: { code: 'validation_error', message: 'Invalid JSON' } });
      }
      if (
        !envelope ||
        typeof envelope.method !== 'string' ||
        !envelope.input ||
        typeof envelope.input !== 'object' ||
        Array.isArray(envelope.input)
      )
        return send(400, {
          error: { code: 'validation_error', message: 'Expected method and input' },
        });
      const input = { ...envelope.input, auth: authorization.slice(7) };
      const result = await transport(envelope.method, input);
      send(200, { result });
    } catch (error) {
      const known = [
        'unauthorized',
        'forbidden',
        'not_found',
        'validation_error',
        'revision_conflict',
        'scope_violation',
        'locked_skill',
        'readonly_skill',
        'executor_unavailable',
        'rate_limited',
        'budget_exceeded',
        'idempotency_conflict',
        'lease_expired',
        'unknown_outcome',
      ];
      const code = known.includes(error?.code)
        ? error.code
        : known.includes(error?.type)
          ? error.type
          : 'internal_error';
      send(
        code === 'unauthorized'
          ? 401
          : code === 'forbidden' || code === 'scope_violation'
            ? 403
            : code === 'not_found'
              ? 404
              : code === 'revision_conflict' || code === 'idempotency_conflict'
                ? 409
                : code === 'internal_error'
                  ? 502
                  : 400,
        {
          error: {
            code,
            message: code === 'internal_error' ? 'Upstream RPC unavailable' : String(error.message),
          },
        },
      );
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [{ OpenCode }, { SkillCurator, methodNames }] = await Promise.all([
    import('@opencode/client'),
    import('opencode-skill-curator/rpc'),
  ]);
  const rpc = OpenCode.make({ baseUrl: process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096' }).rpc(
    SkillCurator,
  );
  const bridge = createBridge((method, input) => {
    if (!methodNames.includes(method))
      throw Object.assign(new Error('Unknown method'), { code: 'not_found' });
    return rpc[method](input);
  });
  const port = Number(process.env.CURATOR_BRIDGE_PORT ?? 8787);
  bridge.listen(port, '127.0.0.1', () =>
    console.log('Skill Curator bridge listening on loopback port ' + port),
  );
}
