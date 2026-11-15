# VALERIA and other external clients

The plugin runs independently of VALERIA. A TypeScript client, HTTP bridge, and Python SDK are provided. VALERIA's repository has not been changed; adapt the bridge to its actual queue API at the integration boundary.

## Connecting

1. Configure `credentials` on the OpenCode server using `examples/opencode.valeria.jsonc`; supply tokens through the environment of the server and corresponding client. Each token binds to a Principal with tenant/workspace and roles.
2. As an administrator, apply `examples/settings.valeria.json` through `settings.patch` with the current revision and an idempotency key. These are **plugin settings applied through RPC**; do not insert them as nonexistent top-level OpenCode configuration fields.
3. The VALERIA UI reads `manager.snapshot`, catalogs/versions/proposals/jobs/settings, and calls the same RPC methods as the TUI.
4. A worker uses a separate token with the worker role and `worker_kind=valeria`. A request from VALERIA with `execution.mode=direct/session` still executes locally in OpenCode.

## HTTP/Python

Run from the built project:

```bash
OPENCODE_URL=http://127.0.0.1:4096 node examples/http-bridge.mjs
CURATOR_WORKSPACE=my-project python3 examples/valeria_client.py
```

The bridge listens on **127.0.0.1:8787**. Its only route is `POST /rpc`, owned by the adapter. It forwards requests through the real `@opencode/client` RPC and does not assume `/api/curator/...` routes exist on the OpenCode server. Set the actual OpenCode URL in the environment. For a protected server, add its standard network authentication to the bridge client configuration according to your deployment method.

```json
{ "method": "skills.list", "input": { "scope": { "workspace_id": "my-project" }, "limit": 50 } }
```

Pass the capability in `Authorization: Bearer ...`. The bridge overwrites `input.auth` from the header, limits request size, leaves CORS disabled, and does not log bodies/tokens. For remote access, place it behind an authenticated TLS reverse proxy. Do not expose the loopback bridge directly.

## Pull worker and durable marker

```text
jobs.lease(worker_id, worker_kind=valeria)
  → job, context, lease_token, expires_at
  → look up the VALERIA task using marker=job.job_id
      confirmed absent: submit exactly once with marker
      present: resume observing the same VALERIA task
      unknown/network failure: stop, reconcile; never submit another task
  → jobs.heartbeat(job_id, worker_id, lease_token, progress)
  → jobs.complete(..., result=<structured JSON>, cost_usd=<reported cost>)
```

Persist the `job_id → VALERIA task ID` mapping in a durable bridge registry **before** retrying after a timeout. Encrypt the secret lease token using a key from a secret store, or keep it in protected service storage; never put plaintext tokens in task metadata/logs. Before retrying submission, check whether a task with the marker already exists. Repeating complete with the original token/worker/payload returns the same job; a conflicting payload is rejected.

After lease expiry, a job becomes `unknown_outcome` and cannot be reassigned. The original worker can reconcile a known outcome using its original capability. An expired lease cannot be extended by heartbeat; a new LLM run is never created automatically. For a canceled job, acknowledgment completes cancellation without publishing the result.

External learning is rejected before lease acceptance when `privacy.send_raw_transcripts_to_external` is disabled. To enable external learning, an administrator must explicitly permit sending redacted history. Skill package contents for review are shared only with the assigned executor within the authorized scope.

With an unlimited job cap (`job.max_cost_usd:null`), a worker may omit unknown `cost_usd` or return a known subtotal with `cost_known:false`. The resulting job exposes incomplete accounting rather than a zero provider bill. A finite job cap still requires a complete nonnegative cost report. Default cost limits are disabled; the 45,000-token context budget and lease/concurrency checks remain active.

The VALERIA dashboard can use `manager.snapshot` directly and poll events through `events.replay`. VALERIA's own UI and deployment require its separate project environment; the server contract is ready for that integration.
