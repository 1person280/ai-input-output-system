# AI Input/Output System

> A VS Code extension that answers simple AI requests with a **local 4B INT8 model**
> and forwards only genuinely complex work to the cloud — then shows you exactly how
> many cloud calls you avoided.

## Why

Every keystroke-sized AI question ("format this", "add a docstring", "rename this
variable") costs a cloud round-trip. A 4B INT8 model with a 64K context window
handles those comfortably on-device. This extension sits in front of your AI
workflow, classifies each request, routes it, and keeps a running tally of the
savings.

## How it works — local routing

```
prompt ──▶ classify(text, context) ──▶ RequestFeatures.complexity
                                              │
                        ┌─────────────────────┴─────────────────────┐
             complexity < threshold                       complexity >= threshold
                        ▼                                          ▼
              llama-server (local 4B)                    OpenAI-compatible cloud
                        │  on failure ▼                            │
                        └────────────▶ cloud fallback ◀────────────┘
                                              │
                                  ledger.record(route, tokens)
                                              │
                                   status bar + dashboard
```

1. **Classify** — token estimate (CJK-aware), multi/cross-file detection, and
   complex/simple intent keywords produce a `complexity` score in `[0, 1]`.
2. **Decide** — `decideRoute(features, threshold)` is a pure function; below the
   threshold the request stays local.
3. **Execute** — local requests hit `llama-server`; failures fall back to the
   cloud so you never lose an answer.
4. **Measure** — every decision is appended to a ledger that feeds the status bar
   and the dashboard.

Details: [`docs/routing.md`](docs/routing.md) · [`docs/architecture.md`](docs/architecture.md) · [`docs/model.md`](docs/model.md) · [`docs/agent.md`](docs/agent.md).

## Install

### From a VSIX

```bash
npm install
npm run package          # produces ai-input-output-system-0.1.0.vsix
code --install-extension ai-input-output-system-0.1.0.vsix
```

### From source (development host)

```bash
npm install
npm run compile
# press F5 in VS Code to launch an Extension Development Host
```

The local model is **not** bundled. Download it and start the server:

```bash
node scripts/download-model.mjs --url <mirror-url> --sha256 <hex>
llama-server -m models/Qwen3-4B-Instruct-Q8_0.gguf --ctx-size 65536 -ngl 99
```

## Configuration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `aiio.cloudBaseUrl` | string | `https://api.openai.com/v1` | OpenAI-compatible base URL for cloud requests. |
| `aiio.cloudApiKey` | string | `""` | API key for the cloud endpoint. |
| `aiio.cloudModel` | string | `gpt-4o-mini` | Model name sent to the cloud. |
| `aiio.localServerUrl` | string | `http://127.0.0.1:8080` | Base URL of the running `llama-server`. |
| `aiio.localModelPath` | string | `""` | Absolute path to the GGUF; empty means `<workspace>/models`. |
| `aiio.routingThreshold` | number | `0.5` | Complexity above which requests go to the cloud. |
| `aiio.enableLocalRouting` | boolean | `true` | Master switch; `false` sends everything to the cloud. |
| `aiio.autonomousOnStartup` | boolean | `false` | Create files from `aiio.autonomousRequirement` on activation. |
| `aiio.autonomousRequirement` | string | `""` | Requirement used for startup creation; empty disables it. |
| `aiio.targetSubdirectory` | string | `aiio-generated` | Workspace-relative folder for generated files. |

## Commands

| Command | ID | What it does |
| --- | --- | --- |
| AI I/O: Route Prompt (Local or Cloud) | `aiio.routePrompt` | Asks for a prompt, shows the routing decision, and returns the answer. |
| AI I/O: Show Savings Dashboard | `aiio.showDashboard` | Opens the webview dashboard (also bound to the status bar). |
| AI I/O: Manage Local Model | `aiio.manageModel` | Inspect / download / start / stop the local model. |
| AI I/O: Create Files From Requirement | `aiio.createFromRequirement` | Turn a natural-language requirement into files in the workspace. |

## How the savings are computed

Each routed request appends one ledger entry:

```ts
{ timestamp: number, route: 'local' | 'cloud', estimatedTokens: number }
```

From the ledger:

| Metric | Formula |
| --- | --- |
| `savingsRatio()` | `local requests ÷ total requests` |
| `tokenSavingsRatio()` | `local tokens ÷ total tokens` |
| `estimatedCloudCostAvoidedUsd` | `localTokens ÷ 1000 × 0.002` (configurable per-1K-token price) |

Fallbacks are recorded with the **actual** route (`cloud`), so a failed local
attempt never inflates the savings. Token counts are estimates: CJK characters
are counted as one token each, everything else at ~4 characters per token.

## Autonomous file creation

Give the extension a requirement in plain language and it writes the files
itself. Planning tries three sources in order — **local model → cloud model →
offline heuristic** — then persists the result into
`<workspace>/<aiio.targetSubdirectory>`. The offline heuristic is a real
fallback: it infers the file name from the requirement and embeds the
requirement text into a type-appropriate skeleton, so a file is always produced
even with no local server and no cloud key. See
[`docs/agent.md`](docs/agent.md) for the full flow and how to verify it.

## Development

```bash
npm install        # install dev dependencies
npm run compile    # esbuild bundle -> dist/extension.js
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src
npm test           # vitest run
npm run package    # build a .vsix via @vscode/vsce
```

Architecture rules enforced by review: each source file stays **under 600 lines**,
file names are **semantic** (no `utils.ts` / `common.ts` / `helpers.ts`), and the
dependency direction is one-way (`ui → routing/metrics → local/cloud`) with the
domain layer free of `vscode` imports.

## License

[MIT](LICENSE) © AI Input/Output System contributors