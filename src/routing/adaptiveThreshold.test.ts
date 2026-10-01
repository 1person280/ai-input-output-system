import { describe, expect, it } from 'vitest';
import {
  computeAdaptiveThreshold,
  DEFAULT_ADAPTATION,
  type AdaptationOptions,
} from './adaptiveThreshold';
import type { DecisionFeedback, DecisionRecord } from './decisionJournal';

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

function feedback(overrides: Partial<DecisionFeedback> = {}): DecisionFeedback {
  return {
    requestId: 'r1',
    verdict: 'good',
    signal: 'explicit',
    timestamp: 1,
    ...overrides,
  };
}

function options(overrides: Partial<AdaptationOptions> = {}): AdaptationOptions {
  return {
    baseThreshold: 0.5,
    enabled: true,
    ...DEFAULT_ADAPTATION,
    ...overrides,
  };
}

/** 生成 n 条本地决策，其中 badCount 条被否定。 */
function journal(n: number, badCount: number): { records: DecisionRecord[]; feedback: DecisionFeedback[] } {
  const records: DecisionRecord[] = [];
  const entries: DecisionFeedback[] = [];
  for (let index = 0; index < n; index += 1) {
    const id = `r${index}`;
    records.push(record({ requestId: id }));
    entries.push(feedback({ requestId: id, verdict: index < badCount ? 'bad' : 'good' }));
  }
  return { records, feedback: entries };
}

describe('computeAdaptiveThreshold', () => {
  it('returns the base threshold when disabled', () => {
    const { records, feedback: entries } = journal(20, 10);
    const result = computeAdaptiveThreshold(records, entries, options({ enabled: false }));
    expect(result.effective).toBe(0.5);
    expect(result.applied).toBe(false);
    expect(result.samples).toBe(0);
  });

  it('does nothing below the minimum feedback sample', () => {
    const { records, feedback: entries } = journal(3, 3);
    const result = computeAdaptiveThreshold(records, entries, options());
    expect(result.effective).toBe(0.5);
    expect(result.applied).toBe(false);
    expect(result.samples).toBe(3);
  });

  it('lowers the threshold when the recent local failure rate exceeds tolerance', () => {
    const { records, feedback: entries } = journal(20, 6);
    const result = computeAdaptiveThreshold(records, entries, options());
    expect(result.applied).toBe(true);
    expect(result.effective).toBeLessThan(0.5);
    expect(result.adjustment).toBeGreaterThan(0);
  });

  it('caps the adjustment at maxAdjustment', () => {
    const { records, feedback: entries } = journal(20, 20);
    const result = computeAdaptiveThreshold(records, entries, options());
    expect(result.effective).toBeCloseTo(0.5 - DEFAULT_ADAPTATION.maxAdjustment);
    expect(result.adjustment).toBeCloseTo(DEFAULT_ADAPTATION.maxAdjustment);
  });

  it('keeps the base threshold while failures stay within tolerance', () => {
    const { records, feedback: entries } = journal(20, 1);
    const result = computeAdaptiveThreshold(records, entries, options());
    expect(result.effective).toBe(0.5);
    expect(result.applied).toBe(false);
  });

  it('only counts local answers: cloud feedback never moves the threshold', () => {
    const records = Array.from({ length: 20 }, (_, index) =>
      record({ requestId: `c${index}`, predictedRoute: 'cloud', actualRoute: 'cloud' })
    );
    const entries = records.map((r) => feedback({ requestId: r.requestId, verdict: 'bad' }));
    const result = computeAdaptiveThreshold(records, entries, options());
    expect(result.samples).toBe(0);
    expect(result.applied).toBe(false);
  });

  it('recovers towards the base as recent feedback improves', () => {
    // 20 条旧的拒否 + 20 条新的好评：窗口只看最近 20 条，应完全回撤。
    const records: DecisionRecord[] = [];
    const entries: DecisionFeedback[] = [];
    for (let index = 0; index < 20; index += 1) {
      records.push(record({ requestId: `old${index}` }));
      entries.push(feedback({ requestId: `old${index}`, verdict: 'bad' }));
    }
    for (let index = 0; index < 20; index += 1) {
      records.push(record({ requestId: `new${index}` }));
      entries.push(feedback({ requestId: `new${index}`, verdict: 'good' }));
    }
    const result = computeAdaptiveThreshold(records, entries, options({ windowSize: 20 }));
    expect(result.effective).toBe(0.5);
    expect(result.applied).toBe(false);
  });

  it('never drops the effective threshold below zero', () => {
    const { records, feedback: entries } = journal(30, 30);
    const result = computeAdaptiveThreshold(
      records,
      entries,
      options({ baseThreshold: 0.02, maxAdjustment: 0.15 })
    );
    expect(result.effective).toBe(0);
  });
});