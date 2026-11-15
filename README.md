# OpenCode Skill Curator

[![CI](https://github.com/ProALgebra/SkillCreator/actions/workflows/ci.yml/badge.svg)](https://github.com/ProALgebra/SkillCreator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Turn completed OpenCode work into reusable skills, review your skill library, and manage changes through a terminal interface or RPC API.

Skill Curator is an OpenCode plugin with a persistent SQLite catalog, conversation learning, semantic optimization, version history, and approval controls. It runs independently; external workers and V.A.L.E.R.I.A. integration are optional.

## Features

- **Learn from conversations.** Analyze the current conversation or a selected past conversation, including errors, corrections, tool results, and reusable procedures.
- **Maintain the library.** Propose focused updates, consolidate overlapping skills, and review stale skills in bounded batches.
- **Control publication.** Publish eligible changes automatically by default, or switch to manual proposal review.
- **Preserve complete packages.** Keep scripts, references, templates, and binary assets with their skills. Merges retain the original packages for recovery.
- **Manage skills in the terminal.** Browse, search, edit, archive, restore, pin, lock, and inspect version history through `/skills-manager`.
- **Integrate through RPC.** Use the same authorization, revisions, idempotency, budgets, and job lifecycle from the TUI, TypeScript/Python clients, or external workers.

## Requirements

| Component              | Supported version                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------- |
| OpenCode               | **2.3.0**, with `@opencode/plugin` and `@opencode/client` pinned to that version   |
| Build and server tests | Node.js **22.21.1+** and npm                                                       |
| TUI test runtime       | Bun **1.3.14+**, included as a development dependency                              |
| Native SQLite          | A native addon build toolchain if `better-sqlite3` has no matching prebuilt binary |

The TUI runs inside OpenCode. The pinned OpenTUI runtime requires Bun 1.3.14+ or Node 26.4+; Node 22 is sufficient to build and test the server core. CI checks Node 22 and 24 on Linux.

## Install from source

The package has not been published to npm. Build it from this repository:

```bash
git clone https://github.com/ProALgebra/SkillCreator.git
cd SkillCreator
npm ci
npm run build
npm pack
```

Add the plugin to your OpenCode server configuration, usually `~/.config/opencode/opencode.jsonc`. Replace the path with your absolute checkout or extracted package directory:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/SkillCreator",
      "options": {
        "tenant_id": "local",
        "local_service_auth": true
      }
    }
  ]
}
```

Add the same plugin entry to `~/.config/opencode/cli.json`. OpenCode 2.3 shares the plugin path with the TUI, but the CLI must receive its options separately.

`local_service_auth` derives a capability token from the existing private OpenCode service credentials. It is intended for the server and TUI running as the same operating-system user. The plugin does not write an additional token to disk. For a custom token or remote client, configure `SKILL_CURATOR_TOKEN` for both processes instead; see [authentication and security](docs/SECURITY.md).

Start OpenCode, or run `opencode reload` if its service is already running. Restart an open CLI after changing its plugin configuration, then run `/skills-manager`.

The default data directory is `.curator` in the selected project. Published skills become available in OpenCode's native skill list without restarting the service. Pending proposals appear in Skill Curator until they are approved and applied.

For upgrades, service configuration, source directories, and troubleshooting, see the [operations guide](docs/OPERATIONS.md). OpenCode 2.3 caches transitive imports inside `node_modules`; use a fresh release directory outside `node_modules` when replacing an installed build.

## Commands

| Command               | Purpose                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `/skills-manager`     | Browse skills, inspect files, and manage proposals and versions        |
| `/skills-refine`      | Extract reusable knowledge from the current or a past conversation     |
| `/skills-learn`       | Learn from verified imported evidence                                  |
| `/skills-review`      | Review selected or eligible skills                                     |
| `/skills-optimize`    | Run semantic optimization, configure its schedule, and inspect reports |
| `/skills-publication` | Switch between manual and automatic publication                        |
| `/skills-jobs`        | Inspect and manage background jobs                                     |
| `/skills-settings`    | Edit settings and publication policy                                   |

In the manager, select a skill with the mouse or **↑/↓**, press **Enter** for actions, use **Ctrl+F** or **Tab** for search, and **Ctrl+R** to synchronize sources. Built-in `skill://` sources are available as read-only previews; an API snapshot does not substitute for a complete publishable package.

## Learning and publication

`/skills-refine` analyzes the SDK-visible context of a conversation in the selected project. The model can propose a new skill, update an eligible managed skill, or return no candidates. Locked, pinned, manual, and third-party skills are protected from automatic changes.

Automatic conversation review is enabled by default. It counts completed tool calls, including failed calls, within each conversation. After **10 actions** and a successfully completed reply, it waits **30 seconds**, checks that the conversation is idle, and queues a review. Counters survive reloads; internal plugin sessions are excluded. Historical conversations are analyzed when selected explicitly, rather than scanned automatically at startup.

The model normally follows the source conversation. Override it or change thresholds through `/skills-settings` using a JSON patch:

```json
{
  "conversation_review": {
    "enabled": true,
    "every_n_actions": 10,
    "min_age_sec": 30,
    "debounce_sec": 5,
    "provider": "your-provider-id",
    "model": "your-model-id"
  }
}
```

The scheduler also respects learning pauses, `auto_learning.enabled`, `on_session_end`, `quiet_hours` in UTC, child-session settings, and budget/concurrency limits. If `conversation_review.enabled=false`, the original verified-fragment trigger remains available through `auto_learning.every_n_sessions`, for example using successful test-command results.

**Publication is automatic by default.** New skills, eligible low-risk managed updates, merges, and evidence-backed archival have automatic permissions enabled. Choose `/skills-publication` → **Manual** to require approval. The switch applies to future analysis results and does not apply existing pending proposals. Existing saved overrides are preserved on upgrade.

Conversation snapshots are unverified input. Literal source quotations provide a review trail, but do not independently verify a model's conclusions. `/skills-learn` is the separate path for sources marked `verified:true`. Daily and job/analysis cost limits default to `null`, which disables monetary caps. The context budget remains **45,000 tokens** by default: large conversations retain their complete redacted source and use bounded extraction and reconciliation jobs. Source, part, call, and concurrency limits also remain active; SDK-compacted conversations may already lack original messages. The plugin does not discover the model's context window, so a provider can still reject a request. See [context analysis](docs/CONTEXT_ANALYSIS.md) for settings, cost, progress, and recovery.

## Automatic curation

Use `/skills-optimize` → **Run now** to review the library. Scheduled semantic analysis is enabled by default; **Automatic review** changes its mode.

| Setting                          | Default                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| Semantic background optimization | Enabled                                                         |
| Review interval                  | 168 hours / 7 days                                              |
| Required inactivity              | 2 hours                                                         |
| Maximum group size               | 8 skills                                                        |
| Maximum groups per pass          | 8, subject to context and budget limits                         |
| Automatic merging                | Enabled for eligible managed skills under automatic publication |

The model returns a structured `keep`, `patch`, `merge`, or `archive` plan. The server validates scope, source revisions and hashes, protection policies, package resources, and source coverage. Merges create compact root instructions and retain complete original packages under `sources/<skill_id>/`.

Preview does not call a model or write to the database. Reports distinguish proposed changes from applied changes. Rollback prepares a separate proposal that requires approval. Semantic equivalence is not proven by size reduction or source quotations; review the diff when evaluating a consolidation. See the [curator guide](docs/CURATOR.md) for settings, limits, and recovery.

## RPC and external workers

The public contract is `skill-curator.v1`, exported from `opencode-skill-curator/rpc`:

```ts
import { OpenCode } from '@opencode/client';
import { SkillCurator } from 'opencode-skill-curator/rpc';

const client = OpenCode.make({ baseUrl: 'http://127.0.0.1:4096' });
const curator = client.rpc(SkillCurator);
const skills = await curator['skills.list'](
  { auth: process.env.SKILL_CURATOR_TOKEN, limit: 50 },
  { location: { directory: '/absolute/path/to/my-project' } },
);
console.log(skills.items);
```

Configure the OpenCode connection credentials separately if the service requires them. Mutations require an `idempotency_key`; changes to existing entities also require `expected_revision`. Background operations return jobs. External worker modes support leases, heartbeats, budgets, and reconciliation of uncertain outcomes.

See the [RPC reference](docs/RPC.md), [TypeScript example](examples/client.ts), and [VALERIA / Python bridge guide](docs/VALERIA.md).

## Documentation

| Guide                                             | Contents                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| [Architecture](docs/ARCHITECTURE.md)              | Modules, persistence, publication, and execution flow                  |
| [Curator](docs/CURATOR.md)                        | Optimization, schedules, reports, and rollback                         |
| [Context analysis](docs/CONTEXT_ANALYSIS.md)      | Complete conversation sources, bounded requests, budgets, and recovery |
| [Operations](docs/OPERATIONS.md)                  | Configuration, upgrades, backup, restore, and troubleshooting          |
| [Security](docs/SECURITY.md)                      | Capabilities, scope isolation, privacy, and approval boundaries        |
| [Acceptance and limitations](docs/ACCEPTANCE.md)  | Verified behavior and SDK limitations                                  |
| [Installation checks](docs/INSTALLATION_CHECK.md) | Recorded checks against a real OpenCode service                        |
| [Specification](docs/SPECIFICATION.md)            | Original design requirements                                           |
| [Task history](TASKS.md)                          | Implementation and verification record                                 |

The built-in direct API returns text without provider usage details. With a finite cost cap, accounting conservatively consumes its reservation; with unlimited cost, the job reports `cost_known:false` and numeric cost is only the known subtotal. Neither mode enforces a hard provider invoice limit. The SDK also lacks authenticated caller identity and private live-event filtering for plugin RPC; Skill Curator uses capability authentication and authorized durable event replay.

## Development

```bash
npm ci
npm run check
npm run test:bun
npm run test:tui
npm run format:check
npm pack
npm run test:package
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [CHANGELOG.md](CHANGELOG.md) for release notes. Tests cover authorization, revision conflicts, idempotency, package integrity, learning evidence, scheduling, publication policies, worker routing, budgets, and crash recovery.

## License

[MIT](LICENSE) © 2026 ProALgebra.
