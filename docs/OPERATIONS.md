# Configuration, upgrades, and backup/restore

## Configuration

Load options in `opencode.jsonc`: `data_directory`, `skill_directory`, `source_roots`, `tenant_id`, `workspace_id`, `token_env`, `local_service_auth`, and `credentials`. The runtime process resolves relative data paths; use absolute paths for deployment. By default, data lives in the selected project's `.curator` directory, and the workspace is derived from OpenCode's location. Standard `.opencode/skills`, `.agents/skills`, and user OpenCode roots are added as readonly sources when present.

`local_service_auth` is disabled by default. For a local service and TUI owned by the same OS user, set `local_service_auth: true`: the capability is derived from the existing OpenCode password in `${XDG_CONFIG_HOME:-~/.config}/opencode/service.json`. The file must be regular, without symlinks or additional hardlinks; POSIX checks also require the current process owner and no group/other access. The plugin does not create or modify this file. An explicit token from `token_env` (default `SKILL_CURATOR_TOKEN`) takes priority. Remote clients and separate workers should use their own environment tokens with bindings in `credentials`.

In the recorded installation, global `~/.config/opencode/opencode.jsonc` loads `~/.local/share/opencode/skill-curator-runtime/releases/0.3.1-a15497222b92` with `local_service_auth: true`. A backup of the previous configuration is stored beside it. After replacing the installed build, run `opencode reload` and check `system.health`. Select the project for every API call with the standard `location` request option; `scope.directory` does not replace location selection. See the [installation report](INSTALLATION_CHECK.md).

Change runtime settings through `settings.get` → `settings.patch({expected_revision,patch,idempotency_key})`. Global → tenant → workspace layers inherit patches; `settings_level` selects the layer, and reset removes its overrides. Global writes require a server-bound `global_admin`. Schema and defaults: `src/settings.ts`. Example patches: `examples/settings.standalone.json` and `examples/settings.valeria.json`.

Defaults are manual approval, direct/session preferences, at most 2 active jobs globally and 1 per workspace, $3 per UTC day per tenant, a $1 reservation per job, and a 45,000 estimated-token context limit. Context size uses a conservative character-based estimate rather than a provider tokenizer. Automatic patching requires `mode=auto` and a separate allow flag; `mode=safe` disables automatic publication.

The entire history is not processed on first startup. `learning.backfill` takes an explicit list of imported transcripts and supports a cursor. The importer is responsible for truthful verified/provenance claims; the server also checks evidence. Test-tool observations with exit code 0 are captured automatically; an execution result without confirmation stays unverified.

Local TUI configuration in `~/.config/opencode/cli.json` must repeat the plugin's `package`/`options` object, including `local_service_auth: true` or a custom `token_env`. In SDK 2.3, server inventory supplies the TUI path while local CLI configuration supplies options. The live installation and checks are documented in [INSTALLATION_CHECK.md](INSTALLATION_CHECK.md).

Review/learning calls from the manager pass the interface's current provider/model/variant. External RPC calls without these parameters use OpenCode's base model. Explicit authentication, rate_limit, and invalid_request rejections fail the job and release the reservation; network disconnects and ambiguous errors retain `unknown_outcome`.

## Backup

1. Call `system.pause` for every served scope, wait for local work to finish, and retain external worker mappings. Reconcile unknown outcomes using durable markers first.
2. Stop the plugin/OpenCode process and confirm no live process owns `curator.sqlite.lock`.
3. Copy the **entire data_directory**, including SQLite/WAL/SHM files when present, and separately copy the selected skill directory if it is outside the data directory. Preserve permissions and protect the backup.

For online backup, trusted Node code in the same process can call `await core.store.db.backup('/protected/path/curator.sqlite')`. The database snapshot includes every version and file, but a consistent directory backup still requires pausing publication. Do not copy only an open `.sqlite` file while ignoring WAL.

For a local executor with `unknown_outcome`, verify that no run is still active and confirm its costs, then have an administrator explicitly call `jobs.cancel` with `confirm_stopped=true`, `reason`, and `cost_usd`. For external workers, reconciliation with the original lease capability is preferable. Reservations for unknown outcomes are not released without confirmation.

## Restore

1. Stop OpenCode. Restore into a new empty directory; retain the damaged/current copy separately.
2. Restore the data directory and selected skill directory from the same backup, including ownership and permissions. Supply environment tokens from your secret store/environment; the database backup does not contain them. For `local_service_auth`, the server and TUI must read the same current private OpenCode service credentials file; transfer it separately from the skill-library backup.
3. A backed-up lock belongs to the previous process. Check its PID and confirm the owner is no longer running; startup removes stale locks automatically. A matching/reused PID requires operator verification.
4. Start a compatible plugin version. Journal recovery runs before API registration. Check `system.health`, `manager.refresh`, `skills.history`, and `jobs.list`.
5. If the database is intact but the materialized skill directory is missing, rehydrate offline with trusted access:

```js
import { CuratorCore } from 'opencode-skill-curator/server';
const core = new CuratorCore({ dataDirectory: '/restored/.curator' });
try {
  for (const skill of core.store.all('skills')) core.catalog.packages.write(skill);
} finally {
  await core.close();
}
```

Do not rehydrate third-party source directories: PackageStore writes only its own managed copies. If symlinks or foreign hardlinks are detected, resolve the substitution separately instead of disabling validation.

## Upgrade

Pin compatible SDK/OpenCode versions. Before upgrading, stop work, make a backup, and run `npm ci`/`npm run check`. The v1 migration creates tables in one transaction and records the schema version. Future migrations must be added explicitly; database downgrade is not supported. Return to an older version by restoring its matching backup instead of deleting fields.

The recorded installation uses a version directory under `~/.local/share/opencode/skill-curator-runtime/releases/`, outside `node_modules`. OpenCode 2.3 does not invalidate cached transitive imports inside `node_modules` during a normal reload. For upgrades, use a new version directory and update `package` in both server and CLI configuration, then run `opencode reload`.

## Troubleshooting

The manager shows skills from the current project, including built-in OpenCode sources with virtual `skill://` paths. These sources are readonly; an API snapshot without a complete package is marked `incomplete_source` and cannot be published as a managed copy. Changing projects changes the catalog. If the selected state contains no entries, check the tabs and search field.

| State                           | Action                                                                                                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unauthorized during loading/TUI | With `local_service_auth`, verify the shared `service.json`, its owner, and private permissions; otherwise use the same server/TUI environment token of at least 24 characters. Remove an unintended environment override or align its value |
| scope_violation                 | Check the server's Principal binding, workspace, and the global skill's owning workspace                                                                                                                                                     |
| readonly_skill                  | Clone a complete third-party package; adoption does not bypass readonly protection                                                                                                                                                           |
| incomplete_source               | Add an allowed source root and run `manager.refresh`; cloning an incomplete copy is prohibited                                                                                                                                               |
| revision_conflict               | Read the entity again; after external file edits, run `manager.refresh` before recreating the proposal                                                                                                                                       |
| unknown_outcome                 | Do not automatically retry or create a new marker; inspect the accepted task and reconcile with the original worker capability                                                                                                               |
| lease_expired                   | Heartbeat cannot extend the lease; complete with the original capability can reconcile a known result                                                                                                                                        |
| budget_exceeded                 | Check spending and reservations retained by unknown jobs; raise limits only through a deliberate administrator patch                                                                                                                         |
| reload pending                  | Check permissions and the SDK; `manager.refresh` and the next `skill.reload` restore the registry                                                                                                                                            |
| storage already open            | Use one server instance per data directory; do not remove a live process's lock                                                                                                                                                              |
| native addon mismatch           | Switch to a supported Node version and run `npm rebuild better-sqlite3` or `npm ci`                                                                                                                                                          |

Direct dependencies with known fixes were updated. `npm audit` may still report transitive SDK/OpenTUI advisories; do not use `--force` to replace the SDK incompatibly. Assess upstream updates separately. The latest recorded check had no high/critical advisories; see [ACCEPTANCE.md](ACCEPTANCE.md) for the report.
