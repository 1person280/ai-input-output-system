/**
 * Domain layer: routing decision quality, online and offline.
 *
 * Two very different measurements live here on purpose, because they have
 * different epistemics:
 *
 * - `computeOnlineQuality` reads the live journal. Only false-locals are
 *   observable, so it reports a local-failure rate plus the feedback *coverage*
 *   needed to trust it — never a full accuracy figure.
 * - `evaluateCorpus` reads a labelled corpus, where both classes have ground
 *   truth, and therefore can produce a real confusion matrix.
 */

import { ClassifierWeights } from './classifierWeights';
import type { DecisionFeedback, DecisionRecord } from './decisionJournal';
import type { LabeledPrompt } from './labeledCorpus';
import { classify } from './requestClassifier';
import { decideRoute, DEFAULT_ROUTING_THRESHOLD } from './routingPolicy';

/** Relative cost of a wrong decision. False-local hurts more than false-cloud. */
export interface CostModel {
  falseLocalWeight: number;
  falseCloudWeight: number;
}

export const DEFAULT_COST_MODEL: CostModel = {
  falseLocalWeight: 3,
  falseCloudWeight: 1,
};

/** Below this feedback coverage the local-failure rate is not trustworthy. */
export const MIN_RELIABLE_COVERAGE = 0.1;

export interface OnlineQuality {
  decided: number;
  withFeedback: number;
  coverage: number;
  /** Requests the policy intended to answer locally. */
  localAttempts: number;
  fallbackCount: number;
  fallbackRate: number;
  localDecisions: number;
  localWithFeedback: number;
  localRejections: number;
  localFailureRate: number;
  /** False when coverage is too low for `localFailureRate` to mean anything. */
  reliable: boolean;
}

export function computeOnlineQuality(
  records: ReadonlyArray<DecisionRecord>,
  feedback: ReadonlyArray<DecisionFeedback>
): OnlineQuality {
  const verdictById = new Map<string, DecisionFeedback['verdict']>();
  for (const entry of feedback) {
    verdictById.set(entry.requestId, entry.verdict);
  }

  let withFeedback = 0;
  let localAttempts = 0;
  let fallbackCount = 0;
  let localDecisions = 0;
  let localWithFeedback = 0;
  let localRejections = 0;

  for (const record of records) {
    const verdict = verdictById.get(record.requestId);
    if (verdict) {
      withFeedback += 1;
    }
    if (record.predictedRoute === 'local') {
      localAttempts += 1;
    }
    if (record.fallbackUsed) {
      fallbackCount += 1;
    }
    if (record.actualRoute === 'local') {
      localDecisions += 1;
      if (verdict) {
        localWithFeedback += 1;
        if (verdict === 'bad') {
          localRejections += 1;
        }
      }
    }
  }

  const decided = records.length;
  const coverage = decided === 0 ? 0 : withFeedback / decided;
  return {
    decided,
    withFeedback,
    coverage,
    localAttempts,
    fallbackCount,
    fallbackRate: localAttempts === 0 ? 0 : fallbackCount / localAttempts,
    localDecisions,
    localWithFeedback,
    localRejections,
    localFailureRate:
      localWithFeedback === 0 ? 0 : localRejections / localWithFeedback,
    reliable: coverage >= MIN_RELIABLE_COVERAGE && localWithFeedback > 0,
  };
}

export interface CorpusQuality {
  threshold: number;
  total: number;
  /** Expected local, predicted local. */
  trueLocal: number;
  /** Expected cloud, predicted local — the costly mistake. */
  falseLocal: number;
  /** Expected cloud, predicted cloud. */
  trueCloud: number;
  /** Expected local, predicted cloud — a wasted cloud call. */
  falseCloud: number;
  accuracy: number;
  cloudPrecision: number;
  cloudRecall: number;
  cloudF1: number;
  cost: CostModel;
  expectedCost: number;
}

export interface CorpusEvaluationOptions {
  weights?: Partial<ClassifierWeights>;
  threshold?: number;
  cost?: CostModel;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Run the classifier over every labelled prompt and build a confusion matrix. */
export function evaluateCorpus(
  corpus: ReadonlyArray<LabeledPrompt>,
  options: CorpusEvaluationOptions = {}
): CorpusQuality {
  const threshold = options.threshold ?? DEFAULT_ROUTING_THRESHOLD;
  const cost = options.cost ?? DEFAULT_COST_MODEL;

  let trueLocal = 0;
  let falseLocal = 0;
  let trueCloud = 0;
  let falseCloud = 0;

  for (const entry of corpus) {
    const features = classify(entry.prompt, {}, { weights: options.weights });
    const predicted = decideRoute(features, threshold);
    const expectedLocal = entry.expectedRoute === 'local';
    const predictedLocal = predicted === 'local';

    if (expectedLocal && predictedLocal) {
      trueLocal += 1;
    } else if (!expectedLocal && predictedLocal) {
      falseLocal += 1;
    } else if (!expectedLocal && !predictedLocal) {
      trueCloud += 1;
    } else {
      falseCloud += 1;
    }
  }

  const total = corpus.length;
  const precision = ratio(trueCloud, trueCloud + falseCloud);
  const recall = ratio(trueCloud, trueCloud + falseLocal);
  return {
    threshold,
    total,
    trueLocal,
    falseLocal,
    trueCloud,
    falseCloud,
    accuracy: ratio(trueLocal + trueCloud, total),
    cloudPrecision: precision,
    cloudRecall: recall,
    cloudF1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    cost,
    expectedCost:
      falseLocal * cost.falseLocalWeight + falseCloud * cost.falseCloudWeight,
  };
}
