import { describe, expect, it } from 'vitest';
import type { DecisionRecord } from './decisionJournal';
import {
  applyLocalCondition,
  DEFAULT_LOCAL_CONDITION_OPTIONS,
  estimateLocalLatency,
  LocalCondition,
} from './localCondition';
import type { RouteDecision } from './routingPolicy';

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    requestId: 'r1',
    timestamp: 1,
    predictedRoute: 'local',
    actualRoute: 'local',
    fallbackUsed: false,
    complexity: 0.2,
    threshold: 0.5,
    tokenEstimate: 100,
    latencyMs: 800,
    ...overrides,
  };
}

function condition(overrides: Partial<LocalCondition> = {}): LocalCondition {
  return { available: true, observedLatencyMs: null, latencySamples: 0, ...overrides };
}

function baseLocal(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return { route: 'local', complexity: 0.2, threshold: 0.5, reason: 'Low complexity', ...overrides };
}

describe('estimateLocalLatency', () => {
  it('returns null with no samples', () => {
    expect(estimateLocalLatency([])).toEqual({ observedLatencyMs: null, latencySamples: 0 });
  });

  it('averages only positive-latency local records', () => {
    const records = [
      record({ requestId: 'a', latencyMs: 1000 }),
      record({ requestId: 'b', latencyMs: 2000 }),
      record({ requestId: 'c', predictedRoute: 'cloud', actualRoute: 'cloud', latencyMs: 50 }),
      record({ requestId: 'd', latencyMs: 0 }),
    ];
    expect(estimateLocalLatency(records)).toEqual({
      observedLatencyMs: 1500,
      latencySamples: 2,
    });
  });
});

describe('applyLocalCondition', () => {
  it('is a no-op when disabled', () => {
    const result = applyLocalCondition(
      baseLocal(),
      condition({ available: false }),
      { ...DEFAULT_LOCAL_CONDITION_OPTIONS, enabled: false }
    );
    expect(result.route).toBe('local');
  });

  it('never overrides a cloud base decision', () => {
    const base: RouteDecision = {
      route: 'cloud',
      complexity: 0.9,
      threshold: 0.5,
      reason: 'Complex intent',
    };
    const result = applyLocalCondition(base, condition({ available: false }), DEFAULT_LOCAL_CONDITION_OPTIONS);
    expect(result).toBe(base);
  });

  it('diverts to the cloud when the local server is unavailable', () => {
    const result = applyLocalCondition(
      baseLocal(),
      condition({ available: false }),
      DEFAULT_LOCAL_CONDITION_OPTIONS
    );
    expect(result.route).toBe('cloud');
    expect(result.reason).toContain('unavailable');
  });

  it('diverts to the cloud when recent latency exceeds the budget', () => {
    const result = applyLocalCondition(
      baseLocal(),
      condition({ observedLatencyMs: 9000, latencySamples: 10 }),
      DEFAULT_LOCAL_CONDITION_OPTIONS
    );
    expect(result.route).toBe('cloud');
    expect(result.reason).toContain('latency');
  });

  it('ignores latency while the sample count is too low', () => {
    const result = applyLocalCondition(
      baseLocal(),
      condition({ observedLatencyMs: 9000, latencySamples: 1 }),
      DEFAULT_LOCAL_CONDITION_OPTIONS
    );
    expect(result.route).toBe('local');
  });

  it('keeps a healthy, fast local decision unchanged', () => {
    const base = baseLocal();
    const result = applyLocalCondition(
      base,
      condition({ observedLatencyMs: 500, latencySamples: 10 }),
      DEFAULT_LOCAL_CONDITION_OPTIONS
    );
    expect(result).toBe(base);
  });
});