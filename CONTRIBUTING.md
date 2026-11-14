# Contributing

Contributions to OpenCode Skill Curator are welcome. For a bug report, include the OpenCode version, operating system, reproduction steps, expected behavior, and relevant error output. For a proposed feature, describe the workflow it should support.

## Development setup

Use Node.js 22.21.1 or newer and npm. The repository pins OpenCode SDK 2.3.0; the installed OpenCode version must match when running live checks.

```bash
git clone https://github.com/ProALgebra/SkillCreator.git
cd SkillCreator
npm ci
npm run check
```

`better-sqlite3` may require a native addon build toolchain. Bun is included as a development dependency for the SQLite and headless OpenTUI checks.

## Before opening a pull request

Run the checks relevant to your change. The complete CI workflow is:

```bash
npm run check
npm run test:bun
npm run test:tui
npm run format:check
npm pack
npm run test:package
```

Use `npm run format` to apply the repository's Prettier configuration. UI text and documentation are written in English. Update relevant documentation and release notes when changing user-visible behavior.

Preserve the shared RPC authorization and publication checks. Model output is untrusted input; new model-driven workflows must return validated proposals. Changes to packages, concurrency, budgets, or recovery should include tests for their failure cases as well as the successful path.

## Live integration checks

Live checks require a running OpenCode service with this plugin installed and local capability authentication configured. They operate on temporary test records and retain audit history:

```bash
npm run test:live
npm run test:refine:live -- --provider your-provider --model-id your-model
npm run test:optimizer:live -- --provider your-provider --model-id your-model --require-merge
```

The latter two commands call the configured model provider and may incur charges. Read the [installation check report](docs/INSTALLATION_CHECK.md) for prerequisites, cleanup behavior, and interpretation of model-dependent results. Building the checkout does not update a separately installed release; follow the [upgrade guide](docs/OPERATIONS.md).

## Project layout

| Path        | Purpose                                                           |
| ----------- | ----------------------------------------------------------------- |
| `src/`      | Server core, OpenCode adapter, RPC contract, and TUI              |
| `test/`     | Unit, integration, recovery, SDK contract, and headless UI checks |
| `scripts/`  | Build helpers and explicit live integration checks                |
| `examples/` | Configuration, clients, and the HTTP/Python bridge                |
| `docs/`     | Architecture, operations, security, RPC, and specification        |

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for module boundaries and [SECURITY.md](docs/SECURITY.md) for the trust model. Runtime state in `.curator/`, credentials, generated `dist/`, dependencies, and package archives are excluded from Git.

## Pull requests

Describe the problem, the resulting behavior, and how you verified the change. Reference a related issue when one exists. Keep unrelated changes separate and preserve the [MIT license](LICENSE).
