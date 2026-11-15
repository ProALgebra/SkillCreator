# Security model

## Trust boundary

The server maps each capability token to a preconfigured Principal. The request's `tenant_id` must match that binding; `workspace_id` must be on the subject's allowlist. Administrators cannot access another tenant. An entity identifier never substitutes for a scope check.

| Role          | Permissions                                                                      |
| ------------- | -------------------------------------------------------------------------------- |
| viewer        | Read the authorized catalog, statistics, events, and diffs                       |
| editor        | Manage skills manually and inspect data                                          |
| curator       | Run learning/reviews, decide on proposals, manage jobs, and inspect data         |
| administrator | All actions within the assigned tenant/workspace, including settings/policy      |
| worker        | Only lease/heartbeat/complete/fail for its worker kind and authenticated subject |

Tokens are read from the environment and are not stored in the database or logs. The optional `local_service_auth: true` mode derives a capability using HMAC-SHA256 from the existing OpenCode service password, with a separate `opencode-skill-curator/local-capability/v1` context. The service password is not used directly as a capability; the derived token stays in memory. This mode is disabled by default and is intended for a server and TUI owned by the same OS user.

Local authentication reads `${XDG_CONFIG_HOME:-~/.config}/opencode/service.json` and requires a password of at least 24 characters. Checks require a regular file without symlinks or additional hardlinks; POSIX checks also require the current process owner and no group/other access. A read or validation failure prevents loading with this authentication method. The plugin does not create or modify the service file. The environment token selected by `token_env` (default `SKILL_CURATOR_TOKEN`) takes priority, so the server and TUI must use the same capability source. Changing the service password requires reloading the plugin and opening a new TUI so both obtain the current capability.

A worker token cannot publish skills. A lease token is bound to one job/attempt and worker. Give remote clients separate environment tokens with appropriate Principal bindings; do not share the local service credentials file. Use TLS, a protected reverse proxy, and OpenCode authentication for a remote server; capabilities supplement transport protection.

SDK 2.3 does not provide a verified caller identity to plugin RPC handlers. The TUI therefore also passes a capability. A remote OpenCode server cannot be treated as one trusted local user. The SDK's shared live event stream does not filter by capability, so private events are intentionally not broadcast through it. `events.replay` uses normal authorization and returns only the allowed scope.

## Files

Writes are restricted to the configured managed-library root and directories with computed names. Checks cover path components, normalization, real paths of allowed sources, symlinks, hardlink counts, and file types. Absolute paths, `..`, file/directory conflicts, and references to missing local dependencies are rejected. External sources are readonly; a complete managed copy is created before maintenance.

Binary files are preserved byte for byte through a base64 envelope. Package scripts are never executed. Merging keeps each source tree separately; changes to a script's assumptions about its working directory require manual diff review.

These protections assume a trusted owner of the local data directory. A hostile process with the same OS permissions can replace files between `lstat` and `rename`; protection against that requires separate OS isolation. The data directory must be owned solely by the service user and must not allow shared writes by other tenants.

## History and LLMs

Secrets, tokens, Bearer/cookie/password values, JWTs, private keys, email addresses, some phone numbers, and private home paths are redacted before transcript storage. Files pass through the same filter before publication, with additional redaction before model dispatch. Detection is heuristic: it does not prove the absence of all PII or unknown secret formats. Owners should review diffs, especially when importing their own history.

Source references and metadata containing detected secrets are rejected. Raw transcripts are not stored in jobs; dispatch materializes the payload. By default, history text is not sent to external executors. The built-in internal session is created with deny-all permissions. Every execution mode returns declarative proposals; the server checks scope, revisions, policy, links, secrets, and response structure.

## Approval and recovery

Only administrators in the authorized scope can call `settings.set_publication_mode`, with revision and idempotency checks. It atomically switches the mode and create/patch permissions; archive settings, privacy, and manual-skill protections are retained. TUI `/skills-publication` calls the same endpoint. Fresh installations default to automatic publication with create, managed low-risk patch, merge, and managed archive permissions enabled; saved overrides are preserved on upgrade.

`safe` and `manual` never publish proposals automatically. Automatic patching requires `approval.mode=auto`, a separate allow flag, managed skills, a low-risk patch, and no lock. Automatic archival requires its own flag, positive usage observations, sufficient age, and no pin/lock. New skills publish automatically only when both `approval.mode=auto` and `allow_auto_create=true`. Automatic merging requires the separate `allow_auto_merge=true` flag together with `mode=auto`; splitting still requires manual approval. These automatic permissions are enabled by default, while manual-skill protection remains mandatory. Automatic approvals use actor `system.policy` and are audited.

Conversation review is separate from the verified-only Learner. A snapshot is stored with `verified:false`, and its candidate carries `evidence_kind:conversation_snapshot`. The model sees untrusted data and returns declarative candidates only. Validation checks literal quotes, the immutable snapshot ID, allowed targets, and fixed revisions/hashes. A quote does not prove that an inference is true. Automatic publication can admit model errors into the library; selecting manual publication allows evaluation before application.

The SDK adapter checks each conversation's directory against the selected project, excludes internal sessions, prevents reads during a response, and detects history changes during capture. Sending context to external/VALERIA executors requires `privacy.send_raw_transcripts_to_external=true`. Permission to share cannot be inferred from conversation contents.

Invalid model output, revision/hash conflicts, an unknown executor outcome, database corruption, or inaccessible files block the affected publication. Restart does not repeat an LLM run with an unknown outcome. Backups contain private redacted data and require the same access restrictions.

The semantic curator excludes manual/readonly/locked/pinned skills and foreign/global skills. It checks plan coverage, literal quotes, revisions/hashes, disk contents, and resource preservation; these checks do not prove semantic equivalence of the new text. Rollback snapshots contain complete original packages and remain private within the same scope. Rollback always prepares a separate manual proposal and never overwrites later changes.
