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

## 2a. Adaptive threshold (`adaptiveThreshold.ts`)

The base threshold is what the user configures; the **effective** threshold is
what the router actually uses. Online, the only observable error is a
**false-local** — a local answer the user rejects. Whether a cloud answer could
have been handled locally is a counterfactual we cannot see. So adaptation is
one-directional:

- it only **lowers** the threshold (sending more to the cloud) when the recent
  local rejection rate exceeds `tolerance`;
- it reads only the **most recent `windowSize`** local feedbacks, so quality that
  improves again lets the threshold **recover** towards the base;
- it does nothing below `minFeedback` samples, and the drop is capped by
  `maxAdjustment`;
- it **never rises above** `aiio.routingThreshold`.

`computeAdaptiveThreshold(records, feedback, options)` is pure and derived from
the persisted journal, so it needs no extra state. Disable it with
`aiio.adaptiveRouting: false`.

Defaults: `minFeedback 8`, `windowSize 50`, `maxAdjustment 0.15`,
`tolerance 0.05`, `sensitivity 1.5`.

## 2b. Local condition gating (`localCondition.ts`)

The base decision is then gated on the local server's condition. Both rules can
only turn a `local` decision into `cloud` — never the reverse:

- **Availability** — if the local server is unreachable, local candidates go
  straight to the cloud instead of attempting a doomed request.
- **Latency** — if the mean latency over the recent local records exceeds
  `latencyBudgetMs` (and there are at least `minLatencySamples` samples), a local
  candidate is diverted to the cloud.

Latency is read from `DecisionRecord.latencyMs`, written by the router on every
request. The probe is cached by `LocalHealthMonitor` (15 s TTL) and refreshed
when stale or when the model is started/stopped. Disable the whole gate with
`aiio.localHealthAware: false`.

## 3. Execution (`router.ts`)

1. `preview()` computes features + decision (used by the UI before sending),
   applying the effective (adaptive) threshold and the local-condition gate.
2. If the decision is `local`, call `llama-server`; on any error, and when
   `fallbackToCloud` is enabled, retry on the cloud and mark `fallbackUsed`.
3. If the decision is `cloud` (or no local client is configured), call the cloud.
4. Record `{ timestamp, route, estimatedTokens }` into the ledger — the **actual**
   route is recorded, so fallbacks count as cloud traffic.

## Tuning

- `aiio.routingThreshold` (`0..1`, default `0.5`): raise it to keep more work
  local, lower it to be more conservative. This is the **base**; the effective
  threshold can sit below it when `aiio.adaptiveRouting` is on.
- `aiio.enableLocalRouting`: master switch; `false` funnels everything to the cloud.
- `aiio.adaptiveRouting` (default `true`): derive the effective threshold from
  feedback (section 2a).
- `aiio.localHealthAware` (default `true`): gate local candidates on availability
  and latency (section 2b).

## Examples

| Prompt | complexity | Route at 0.5 |
| --- | --- | --- |
| `Format this function` | ~0.15 | local |
| `Add a docstring` | ~0.15 | local |
| `Refactor this module for testability` | ~0.80 | cloud |
| `帮我重构这段代码，考虑并发安全` | ~0.80 | cloud |