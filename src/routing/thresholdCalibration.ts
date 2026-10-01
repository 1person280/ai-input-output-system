/**
 * Domain layer: offline threshold and weight calibration.
 *
 * Both functions are pure and take the corpus as plain data. They never write
 * configuration: they print a recommendation so a human reviews the change
 * before the defaults move. Small-sample over-fitting is the risk being
 * deliberately kept out of the runtime path.
 */

import {
  ClassifierWeights,
  DEFAULT_CLASSIFIER_WEIGHTS,
  normaliseWeights,
} from './classifierWeights';
import {
  CorpusQuality,
  CostModel,
  DEFAULT_COST_MODEL,
  evaluateCorpus,
} from './decisionQuality';
import type { LabeledPrompt } from './labeledCorpus';

export interface ThresholdPoint {
  threshold: number;
  quality: CorpusQuality;
}

export interface SweepOptions {
  weights?: Partial<ClassifierWeights>;
  cost?: CostModel;
  step?: number;
}

/** Scan every threshold in [0, 1] and record the outcome at each cut-over. */
export function sweepThresholds(
  corpus: ReadonlyArray<LabeledPrompt>,
  options: SweepOptions = {}
): ThresholdPoint[] {
  const step = options.step && options.step > 0 ? options.step : 0.01;
  const points: ThresholdPoint[] = [];
  const steps = Math.round(1 / step);
  for (let index = 0; index <= steps; index += 1) {
    const threshold = Math.min(1, index * step);
    points.push({
      threshold,
      quality: evaluateCorpus(corpus, {
        weights: options.weights,
        threshold,
        cost: options.cost ?? DEFAULT_COST_MODEL,
      }),
    });
  }
  return points;
}

/** Lowest expected cost wins; ties prefer the lower threshold (more local). */
export function bestThreshold(
  points: ReadonlyArray<ThresholdPoint>
): ThresholdPoint | null {
  let best: ThresholdPoint | null = null;
  for (const point of points) {
    if (
      !best ||
      point.quality.expectedCost < best.quality.expectedCost ||
      (point.quality.expectedCost === best.quality.expectedCost &&
        point.threshold < best.threshold)
    ) {
      best = point;
    }
  }
  return best;
}

export type TunableKey =
  | 'baseScore'
  | 'complexIntentBonus'
  | 'simpleIntentPenalty'
  | 'multiFileBonus';

/**
 * Highest-leverage coefficients. `baseScore` is included because it sets where
 * a neutral prompt (no intent signal) lands, which is the single largest source
 * of disagreement between the classifier and human labels.
 */
export const DEFAULT_TUNABLES: ReadonlyArray<TunableKey> = [
  'baseScore',
  'complexIntentBonus',
  'simpleIntentPenalty',
  'multiFileBonus',
];

export interface TuneOptions {
  tunables?: ReadonlyArray<TunableKey>;
  /** Coordinate-descent rounds; each round halves the step. */
  rounds?: number;
  /** Initial step applied to each weight, in the weight's own units. */
  step?: number;
  minStep?: number;
  cost?: CostModel;
  /** Coarser sweep used during tuning to keep the search bounded. */
  thresholdStep?: number;
}

export interface TuneResult {
  weights: ClassifierWeights;
  threshold: number;
  quality: CorpusQuality;
  /** Human-readable log of accepted moves, for review. */
  trace: string[];
}

function evaluateAt(
  corpus: ReadonlyArray<LabeledPrompt>,
  weights: ClassifierWeights,
  cost: CostModel,
  thresholdStep: number
): ThresholdPoint | null {
  return bestThreshold(sweepThresholds(corpus, { weights, cost, step: thresholdStep }));
}

/**
 * Coordinate descent over the highest-leverage weights. Each round varies one
 * weight at a time, re-picks the best threshold, and keeps the move only when
 * the expected cost strictly improves.
 */
export function coordinateTune(
  corpus: ReadonlyArray<LabeledPrompt>,
  seed: Partial<ClassifierWeights> = {},
  options: TuneOptions = {}
): TuneResult {
  const cost = options.cost ?? DEFAULT_COST_MODEL;
  const tunables = options.tunables ?? DEFAULT_TUNABLES;
  const rounds = options.rounds ?? 4;
  const minStep = options.minStep ?? 0.005;
  const thresholdStep = options.thresholdStep ?? 0.02;
  const trace: string[] = [];

  if (corpus.length === 0) {
    throw new Error('Cannot tune on an empty corpus');
  }

  let weights = normaliseWeights({ ...DEFAULT_CLASSIFIER_WEIGHTS, ...seed });
  let current = evaluateAt(corpus, weights, cost, thresholdStep);
  if (!current) {
    throw new Error('Cannot tune on an empty corpus');
  }
  let step = options.step ?? 0.05;

  for (let round = 0; round < rounds && step >= minStep; round += 1) {
    for (const key of tunables) {
      const baseline = weights[key];
      for (const delta of [step, -step]) {
        const candidate = normaliseWeights({ ...weights, [key]: baseline + delta });
        const point = evaluateAt(corpus, candidate, cost, thresholdStep);
        if (point && point.quality.expectedCost < current.quality.expectedCost) {
          trace.push(
            `${key} ${baseline.toFixed(3)} -> ${candidate[key].toFixed(3)} (cost ${current.quality.expectedCost} -> ${point.quality.expectedCost})`
          );
          weights = candidate;
          current = point;
        }
      }
    }
    step /= 2;
  }

  return {
    weights,
    threshold: current.threshold,
    quality: current.quality,
    trace,
  };
}
