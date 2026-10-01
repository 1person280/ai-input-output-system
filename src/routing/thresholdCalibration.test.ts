import { describe, expect, it } from 'vitest';
import { evaluateCorpus } from './decisionQuality';
import type { LabeledPrompt } from './labeledCorpus';
import {
  bestThreshold,
  coordinateTune,
  sweepThresholds,
} from './thresholdCalibration';

const corpus: LabeledPrompt[] = [
  { prompt: 'Format this function', expectedRoute: 'local' },
  { prompt: 'Rename this variable', expectedRoute: 'local' },
  { prompt: 'Refactor this module', expectedRoute: 'cloud' },
  { prompt: 'Debug this concurrency issue', expectedRoute: 'cloud' },
];

describe('sweepThresholds', () => {
  it('produces one point per step across [0, 1]', () => {
    const points = sweepThresholds(corpus, { step: 0.1 });
    expect(points).toHaveLength(11);
    expect(points[0].threshold).toBe(0);
    expect(points[points.length - 1].threshold).toBeCloseTo(1);
  });

  it('sends everything to the cloud at the lowest threshold', () => {
    const points = sweepThresholds(corpus, { step: 0.5 });
    const lowest = points[0];
    expect(lowest.quality.trueCloud).toBe(2);
    expect(lowest.quality.falseCloud).toBe(2);
  });
});

describe('bestThreshold', () => {
  it('returns the point with the lowest expected cost', () => {
    const points = sweepThresholds(corpus, { step: 0.05 });
    const best = bestThreshold(points);
    expect(best).not.toBeNull();
    const minCost = Math.min(...points.map((point) => point.quality.expectedCost));
    expect(best?.quality.expectedCost).toBe(minCost);
  });

  it('returns null for an empty sweep', () => {
    expect(bestThreshold([])).toBeNull();
  });
});

describe('coordinateTune', () => {
  it('never makes the calibrated cost worse than the default', () => {
    const baseline = evaluateCorpus(corpus).expectedCost;
    const result = coordinateTune(corpus, {}, { rounds: 2 });
    expect(result.quality.expectedCost).toBeLessThanOrEqual(baseline);
    expect(result.threshold).toBeGreaterThanOrEqual(0);
    expect(result.threshold).toBeLessThanOrEqual(1);
  });

  it('rejects an empty corpus', () => {
    expect(() => coordinateTune([])).toThrow(/empty corpus/i);
  });
});
