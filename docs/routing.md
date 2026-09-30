# Routing

Routing answers one question: **can a 4B INT8 local model handle this, or does it
need the cloud?**

## 1. Feature extraction (`requestClassifier.ts`)

`classify(text, context)` is a pure function returning `RequestFeatures`:

| Feature | Meaning |
| --- | --- |
| `estimatedTokens` | `CJK chars × 1 + other chars ÷ 4`, summed over the prompt and referenced code. |
| `isMultiFile` | More than one editor tab is open. |
| `isCrossFile` | The prompt names a file other than the active one. |
| `hasComplexIntent` | Matched refactor / architecture / design / debug / migration / performance / concurrency / security / algorithm keywords (EN + 中文). |
| `hasSimpleIntent` | Matched format / indent / rename / comment / docstring / spelling / add-log keywords (EN + 中文). |
| `complexity` | Score in `[0, 1]`, computed below. |

### Complexity score

```
score = 0.50
      + min(0.30, estimatedTokens / 65536 × 10)   // context pressure
      + 0.12 if isMultiFile
      + 0.10 if isCrossFile
      + 0.30 if hasComplexIntent
      - 0.35 if hasSimpleIntent
      - 0.15 if hasSimpleIntent && !hasComplexIntent && estimatedTokens < 2048
clamp to [0, 1]
```

## 2. Decision (`routingPolicy.ts`)

```ts
decideRoute(features, threshold, enableLocalRouting) → 'local' | 'cloud'
```

- `enableLocalRouting === false` → always `cloud`.
- otherwise `features.complexity < threshold` → `local`, else `cloud`
  (the threshold is inclusive for the cloud).

`explainRoute` returns the same decision plus a human-readable `reason`, which
the dashboard and the post-request summary display.

## 3. Execution (`router.ts`)

1. `preview()` computes features + decision (used by the UI before sending).
2. If the decision is `local`, call `llama-server`; on any error, and when
   `fallbackToCloud` is enabled, retry on the cloud and mark `fallbackUsed`.
3. If the decision is `cloud` (or no local client is configured), call the cloud.
4. Record `{ timestamp, route, estimatedTokens }` into the ledger — the **actual**
   route is recorded, so fallbacks count as cloud traffic.

## Tuning

- `aiio.routingThreshold` (`0..1`, default `0.5`): raise it to keep more work
  local, lower it to be more conservative.
- `aiio.enableLocalRouting`: master switch; `false` funnels everything to the cloud.

## Examples

| Prompt | complexity | Route at 0.5 |
| --- | --- | --- |
| `Format this function` | ~0.15 | local |
| `Add a docstring` | ~0.15 | local |
| `Refactor this module for testability` | ~0.80 | cloud |
| `帮我重构这段代码，考虑并发安全` | ~0.80 | cloud |