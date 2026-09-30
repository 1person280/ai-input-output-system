# Architecture

The extension is split into three layers with a **single, acyclic dependency
direction**:

```
presentation (src/ui, src/extension.ts)
        │        │        │        │
        ▼        ▼        ▼        ▼
   domain (src/routing, src/metrics/savingsLedger.ts)
        │
        ▼
infrastructure (src/local, src/cloud, src/metrics/metricsStore.ts, src/config)
```

## Layers

| Layer | Path | May import | Must not import |
| --- | --- | --- | --- |
| Presentation | `src/ui/`, `src/extension.ts` | domain, infrastructure | — |
| Domain | `src/routing/`, `src/metrics/savingsLedger.ts` | domain | `vscode`, `node:fs`, network |
| Infrastructure | `src/local/`, `src/cloud/`, `src/metrics/metricsStore.ts`, `src/config/` | domain, other infrastructure | presentation |

The domain layer is **pure**: `requestClassifier`, `routingPolicy` and
`savingsLedger` are plain functions/classes with no VS Code import, which is why
they run unmodified under Vitest in a bare Node process.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `src/config/settings.ts` | The only place that knows VS Code configuration keys. |
| `src/routing/requestClassifier.ts` | Pure `classify(text, context) -> RequestFeatures`. |
| `src/routing/routingPolicy.ts` | Pure `decideRoute(features, threshold) -> 'local' \| 'cloud'`. |
| `src/routing/router.ts` | Orchestrates one request; owns cloud fallback. |
| `src/local/localModelClient.ts` | HTTP client for `llama-server`. |
| `src/local/modelManager.ts` | GGUF discovery + `llama-server` process lifecycle. |
| `src/cloud/cloudClient.ts` | OpenAI-compatible `/v1/chat/completions` over `fetch`. |
| `src/metrics/savingsLedger.ts` | Pure ledger + `savingsRatio()` + `snapshot()`. |
| `src/metrics/metricsStore.ts` | Persists the ledger via `globalState`. |
| `src/ui/*` | Status bar, webview dashboard, command registration. |

## Conventions

- **Max 600 lines per source file.**
- **Semantic file names only** — no `utils.ts`, `common.ts`, `misc.ts`, `helpers.ts`.
- Every module has exactly one reason to change; the dependency graph above must
  stay acyclic (verified by review, and by the fact that domain tests compile
  without `@types/vscode` being imported).

## Request flow

```
User prompt ──▶ requestClassifier.classify ──▶ RequestFeatures
                                                │
                                                ▼
                        routingPolicy.decideRoute (threshold)
                                                │
                        ┌───────────────────────┴───────────────────────┐
                        ▼                                               ▼
              localModelClient.complete                     cloudClient.complete
                        │  (on failure, when enabled)                   │
                        └──────────────▶ cloudClient.complete ◀─────────┘
                                                │
                                                ▼
                                  savingsLedger.record(route, tokens)
                                                │
                                                ▼
                                     statusBar + dashboardPanel
```