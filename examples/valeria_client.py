"""Dependency-free client for examples/http-bridge.mjs (not raw OpenCode routes)."""
import json
import os
import urllib.request
import urllib.error
import uuid


class CuratorError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class CuratorClient:
    def __init__(self, url, token, workspace_id):
        self.url = url.rstrip('/') + '/rpc'
        self.token = token
        self.workspace_id = workspace_id

    def call(self, method, **inputs):
        inputs.setdefault('scope', {'workspace_id': self.workspace_id})
        data = json.dumps({'method': method, 'input': inputs}).encode()
        request = urllib.request.Request(self.url, data=data, method='POST', headers={
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + self.token,
        })
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)['result']
        except urllib.error.HTTPError as error:
            try:
                value = json.load(error)['error']
            except (ValueError, KeyError):
                raise CuratorError('internal_error', 'Invalid bridge response') from None
            raise CuratorError(value['code'], value['message']) from None

    def mutate(self, method, **inputs):
        # Reuse this key on a transport retry; do not call mutate() again to retry.
        inputs.setdefault('idempotency_key', str(uuid.uuid4()))
        return self.call(method, **inputs)


if __name__ == '__main__':
    client = CuratorClient(os.getenv('CURATOR_BRIDGE_URL', 'http://127.0.0.1:8787'),
                           os.environ['SKILL_CURATOR_TOKEN'],
                           os.getenv('CURATOR_WORKSPACE', 'my-project'))
    print(json.dumps(client.call('system.health'), ensure_ascii=False, indent=2))
