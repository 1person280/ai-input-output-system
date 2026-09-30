# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/ai-input-output-system/ai-input-output-system/releases/tag/v0.1.0