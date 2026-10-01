# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-01

### Added

- Calibratable classifier: every coefficient behind the complexity score now lives
  in `classifierWeights.ts` and the vocabulary in `intentLexicon.ts`, both
  injectable into `classify` so offline tuning never touches the runtime path.
- Offline calibration toolkit: `evaluateCorpus` (confusion matrix over a labelled
  corpus with an asymmetric cost model), `sweepThresholds`, `coordinateTune`, and
  a 125-prompt disaster/regression corpus gated in CI.
- Decision journal (`decisionJournal.ts` + store + `Router` hooks) recording the
  predicted vs. actual route per request, with optional in-editor feedback
  (`aiio.collectRoutingFeedback`).
- "Routing quality" section on the dashboard: journal-derived local-failure rate
  and feedback coverage, never a fabricated accuracy figure.
- `aiio.classifierWeights` setting for per-workspace coefficient overrides.

### Changed

- `baseScore` default lowered 0.5 → 0.45 so a neutral prompt lands on the local
  side of the 0.5 cut-over instead of tipping over from incidental token
  pressure. Fixes the dominant false-cloud class.
- A cosmetic request tacked onto a hard task ("refactor this and add comments") no
  longer cancels the complexity signal; the simple-intent penalty only applies
  when no complex intent was detected.
- `thread-safe` now matches the thread-safety vocabulary alongside `thread safety`.

## [0.1.0] - 2026-09-30

### Added

- Initial release of the **AI Input/Output System** VS Code extension.
- Pure domain layer: `requestClassifier` (CJK-aware token estimation, complex and
  simple intent detection, complexity scoring) and `routingPolicy`
  (`decideRoute` / `explainRoute`).
- Request orchestration in `router.ts` with transparent cloud fallback when the
  local server is unavailable.
- Infrastructure clients: OpenAI-compatible `CloudClient` and `LocalModelClient`
  for `llama-server` (`/v1/chat/completions`, `/completion`, `/health`), both on
  the built-in `fetch` with timeouts.
- `ModelManager` for GGUF discovery and `llama-server` process lifecycle, plus
  `scripts/download-model.mjs` for streaming the weights.
- `SavingsLedger` accounting (`savingsRatio`, `tokenSavingsRatio`, estimated cloud
  spend avoided) persisted through `MetricsStore` and `globalState`.
- UI: status-bar readout, dependency-free SVG webview dashboard, and three
  commands (`aiio.routePrompt`, `aiio.showDashboard`, `aiio.manageModel`).
- Tooling: esbuild bundling, Vitest unit tests, ESLint, GitHub Actions CI.

[0.2.0]: https://github.com/ai-input-output-system/ai-input-output-system/releases/tag/v0.2.0
[0.1.0]: https://github.com/ai-input-output-system/ai-input-output-system/releases/tag/v0.1.0