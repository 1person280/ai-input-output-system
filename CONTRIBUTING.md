# Contributing

Thanks for helping improve **AI Input/Output System**. This document covers the
environment, the directory conventions and the commit rules.

## Development environment

| Requirement | Version |
| --- | --- |
| Node.js | 18 or newer (CI uses 20) |
| npm | bundled with Node |
| VS Code | 1.85.0 or newer |
| llama.cpp (optional) | for running the local model |

```bash
git clone https://github.com/ai-input-output-system/ai-input-output-system.git
cd ai-input-output-system
npm install
npm run compile
```

Press **F5** in VS Code to launch an Extension Development Host.

## Directory conventions

```
src/
  extension.ts        composition root (activate/deactivate)
  config/             VS Code settings adapter
  routing/            domain + orchestration (pure where possible)
  metrics/            savings ledger (pure) and its persistence
  local/              llama-server client + model lifecycle
  cloud/              OpenAI-compatible client
  ui/                 status bar, dashboard webview, commands
docs/                 architecture, routing and model notes
scripts/              one-off Node tooling (model download)
```

Rules:

- **One concept per file**, maximum **600 lines**.
- **Semantic file names only.** `utils.ts`, `common.ts`, `misc.ts` and
  `helpers.ts` are rejected in review — name the file after what it does
  (`requestClassifier.ts`, not `helpers.ts`).
- **Dependency direction is one-way:** `ui → routing/metrics → local/cloud`.
  Never import `vscode` from `src/routing/` or `src/metrics/savingsLedger.ts`;
  those modules must stay unit-testable in a bare Node process.
- New behaviour in the domain layer needs a Vitest case next to it
  (`*.test.ts`).

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>
```

| Type | Use for |
| --- | --- |
| `feat` | A new capability |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `refactor` | No behaviour change |
| `test` | Tests only |
| `chore` | Build, tooling, dependency bumps |

Rules:

- Subject in the imperative mood, no trailing period, under 72 characters.
- One logical change per commit.
- Reference issues in the body when relevant (`Refs #12`).

## Before opening a pull request

```bash
npm run typecheck
npm run lint
npm test
npm run compile
```

All four must pass. CI runs the same checks on Node 20.

## Reporting issues

Include the extension version, VS Code version, the routed decision shown in the
answer summary, and whether `llama-server` was reachable.