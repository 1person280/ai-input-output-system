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
| `src/routing/classifierWeights.ts` | Pure `ClassifierWeights` value object + clamping defaults. |
| `src/routing/intentLexicon.ts` | Intent vocabulary as data (strong/weak) + compiled cache. |
| `src/routing/requestClassifier.ts` | Pure `classify(text, context, options) -> RequestFeatures`. |
| `src/routing/routingPolicy.ts` | Pure `decideRoute(features, threshold) -> 'local' \| 'cloud'`. |
| `src/routing/decisionJournal.ts` | Pure append-only journal of decisions + user feedback. |
| `src/routing/decisionQuality.ts` | Pure online quality + offline corpus confusion matrix. |
| `src/routing/adaptiveThreshold.ts` | Pure effective threshold derived online from feedback (tighten-only). |
| `src/routing/localCondition.ts` | Pure availability/latency gate applied on top of a base decision. |
| `src/routing/thresholdCalibration.ts` | Pure threshold sweep + coordinate-descent weight tuning. |
| `src/routing/router.ts` | Orchestrates one request; owns cloud fallback. |
| `src/local/localModelClient.ts` | HTTP client for `llama-server`. |
| `src/local/localHealthMonitor.ts` | TTL-cached `llama-server` health probe for routing gating. |
| `src/local/modelManager.ts` | GGUF discovery + `llama-server` process lifecycle. |
| `src/cloud/cloudClient.ts` | OpenAI-compatible `/v1/chat/completions` over `fetch`. |
| `src/metrics/savingsLedger.ts` | Pure ledger + `savingsRatio()` + `snapshot()`. |
| `src/metrics/metricsStore.ts` | Persists the savings ledger via `globalState`. |
| `src/metrics/decisionJournalStore.ts` | Persists the decision journal via `globalState`. |
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
                    adaptiveThreshold.computeAdaptiveThreshold
                    (journal feedback → effective threshold)
                                                │
                                                ▼
                        routingPolicy.decideRoute (effective threshold)
                                                │
                                                ▼
                     localCondition.applyLocalCondition (journal latency +
                     LocalHealthMonitor availability → may divert to cloud)
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