import { describe, expect, it } from 'vitest';
import type { RequestFeatures } from './requestClassifier';
import {
  DEFAULT_ROUTING_THRESHOLD,
  decideRoute,
  explainRoute,
  normaliseThreshold,
} from './routingPolicy';

function features(overrides: Partial<RequestFeatures> = {}): RequestFeatures {
  return {
    estimatedTokens: 200,
    isMultiFile: false,
    isCrossFile: false,
    hasComplexIntent: false,
    hasSimpleIntent: false,
    complexIntentHits: [],
    simpleIntentHits: [],
    complexity: 0.2,
    ...overrides,
  };
}

describe('normaliseThreshold', () => {
  it('falls back to the default for non-finite values', () => {
    expect(normaliseThreshold(Number.NaN)).toBe(DEFAULT_ROUTING_THRESHOLD);
  });

  it('clamps to [0, 1]', () => {
    expect(normaliseThreshold(-3)).toBe(0);
    expect(normaliseThreshold(4)).toBe(1);
  });
});

describe('decideRoute', () => {
  it('routes low-complexity features locally', () => {
    expect(decideRoute(features({ complexity: 0.1 }), 0.5)).toBe('local');
  });

  it('routes high-complexity features to the cloud', () => {
    expect(decideRoute(features({ complexity: 0.9 }), 0.5)).toBe('cloud');
  });

  it('treats the threshold as inclusive for the cloud', () => {
    expect(decideRoute(features({ complexity: 0.5 }), 0.5)).toBe('cloud');
  });

  it('always uses the cloud when local routing is disabled', () => {
    expect(decideRoute(features({ complexity: 0 }), 0.5, false)).toBe('cloud');
  });

  it('lowers cloud traffic as the threshold rises', () => {
    const f = features({ complexity: 0.6 });
    expect(decideRoute(f, 0.4)).toBe('cloud');
    expect(decideRoute(f, 0.8)).toBe('local');
  });
});

describe('explainRoute', () => {
  it('explains simple local routing', () => {
    const decision = explainRoute(features({ complexity: 0.1, hasSimpleIntent: true }), 0.5);
    expect(decision.route).toBe('local');
    expect(decision.reason).toMatch(/simple intent/i);
  });

  it('surfaces the complex intent keywords', () => {
    const decision = explainRoute(
      features({ complexity: 0.9, hasComplexIntent: true, complexIntentHits: ['refactor'] }),
      0.5
    );
    expect(decision.route).toBe('cloud');
    expect(decision.reason).toContain('refactor');
  });

  it('reports disabled local routing', () => {
    const decision = explainRoute(features({ complexity: 0.1 }), 0.5, false);
    expect(decision.route).toBe('cloud');
    expect(decision.reason).toMatch(/disabled/i);
  });
});