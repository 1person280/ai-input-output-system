import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLASSIFIER_WEIGHTS,
  normaliseWeights,
} from './classifierWeights';

describe('normaliseWeights', () => {
  it('returns the defaults when nothing is provided', () => {
    expect(normaliseWeights()).toEqual(DEFAULT_CLASSIFIER_WEIGHTS);
  });

  it('merges a partial override onto the defaults', () => {
    const weights = normaliseWeights({ complexIntentBonus: 0.4 });
    expect(weights.complexIntentBonus).toBe(0.4);
    expect(weights.simpleIntentPenalty).toBe(
      DEFAULT_CLASSIFIER_WEIGHTS.simpleIntentPenalty
    );
  });

  it('clamps values into their bounds', () => {
    expect(normaliseWeights({ baseScore: 5 }).baseScore).toBe(1);
    expect(normaliseWeights({ baseScore: -5 }).baseScore).toBe(0);
    expect(normaliseWeights({ localContextTokens: 10 }).localContextTokens).toBe(
      1024
    );
    expect(
      normaliseWeights({ maxIntentMultiplier: 0.2 }).maxIntentMultiplier
    ).toBe(1);
  });

  it('falls back to the default for non-finite values', () => {
    expect(normaliseWeights({ baseScore: Number.NaN }).baseScore).toBe(
      DEFAULT_CLASSIFIER_WEIGHTS.baseScore
    );
    expect(
      normaliseWeights({ complexIntentBonus: Number.POSITIVE_INFINITY })
        .complexIntentBonus
    ).toBe(DEFAULT_CLASSIFIER_WEIGHTS.complexIntentBonus);
  });
});
