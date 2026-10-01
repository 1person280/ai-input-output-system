/**
 * Domain layer: the tunable coefficients behind the complexity score.
 *
 * `computeComplexity` used to hard-code these numbers inline, which made the
 * classifier impossible to calibrate. They now live in one value object so the
 * offline tuner (see `thresholdCalibration.ts`) can vary them against a labelled
 * corpus without touching the classification logic itself.
 */

export interface ClassifierWeights {
  /** Score before any signal is applied; the neutral mid-point. */
  baseScore: number;
  /** Context window of the local model, used to normalise token pressure. */
  localContextTokens: number;
  /** Multiplier turning a token-pressure ratio into a bonus. */
  tokenPressureScale: number;
  /** Upper bound on the token-pressure bonus. */
  tokenPressureCap: number;
  /** Bonus for requests that touch more than one file. */
  multiFileBonus: number;
  /** Bonus for requests that reference a file other than the active one. */
  crossFileBonus: number;
  /** Bonus for a single strong complex-intent hit. */
  complexIntentBonus: number;
  /** How much a weak complex-intent hit counts relative to a strong one. */
  weakIntentScale: number;
  /** Cap on how much multiple intent hits can amplify the base bonus. */
  maxIntentMultiplier: number;
  /** Penalty for a simple-intent hit. */
  simpleIntentPenalty: number;
  /** Extra penalty for small, purely simple requests. */
  smallSimpleBonus: number;
  /** Token ceiling below which the extra simple penalty applies. */
  smallSimpleTokenLimit: number;
}

export const DEFAULT_CLASSIFIER_WEIGHTS: ClassifierWeights = {
  // Sits just below the 0.5 cut-over so a neutral prompt with no intent signal
  // lands on the local side. At 0.5 exactly, the tiny token pressure from any
  // prompt pushes it to 0.501 and every "explain this" request paid for a cloud
  // call — the single largest source of false-cloud in the labelled corpus.
  baseScore: 0.45,
  localContextTokens: 65536,
  tokenPressureScale: 10,
  tokenPressureCap: 0.3,
  multiFileBonus: 0.12,
  crossFileBonus: 0.1,
  complexIntentBonus: 0.3,
  weakIntentScale: 0.5,
  maxIntentMultiplier: 1.5,
  simpleIntentPenalty: 0.35,
  smallSimpleBonus: 0.15,
  smallSimpleTokenLimit: 2048,
};

/** Inclusive [min, max] bounds used to reject nonsensical persisted values. */
const WEIGHT_BOUNDS: Record<keyof ClassifierWeights, [number, number]> = {
  baseScore: [0, 1],
  localContextTokens: [1024, 1_048_576],
  tokenPressureScale: [0, 100],
  tokenPressureCap: [0, 1],
  multiFileBonus: [0, 1],
  crossFileBonus: [0, 1],
  complexIntentBonus: [0, 1],
  weakIntentScale: [0, 1],
  maxIntentMultiplier: [1, 5],
  simpleIntentPenalty: [0, 1],
  smallSimpleBonus: [0, 1],
  smallSimpleTokenLimit: [0, 1_048_576],
};

export const WEIGHT_KEYS = Object.keys(WEIGHT_BOUNDS) as Array<
  keyof ClassifierWeights
>;

/**
 * Merge a partial override onto the defaults, clamping every field into its
 * bound. Non-finite or missing values silently fall back to the default, so a
 * bad user setting can never make the classifier behave unpredictably.
 */
export function normaliseWeights(
  partial: Partial<ClassifierWeights> = {}
): ClassifierWeights {
  const merged = { ...DEFAULT_CLASSIFIER_WEIGHTS, ...partial };
  const normalised = {} as ClassifierWeights;
  for (const key of WEIGHT_KEYS) {
    const [min, max] = WEIGHT_BOUNDS[key];
    const value = merged[key];
    normalised[key] = Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : DEFAULT_CLASSIFIER_WEIGHTS[key];
  }
  return normalised;
}
