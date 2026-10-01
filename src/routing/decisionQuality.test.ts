import { describe, expect, it } from 'vitest';
import type { DecisionFeedback, DecisionRecord } from './decisionJournal';
import {
  computeOnlineQuality,
  DEFAULT_COST_MODEL,
  evaluateCorpus,
} from './decisionQuality';
import type { LabeledPrompt } from './labeledCorpus';

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

describe('computeOnlineQuality', () => {
  it('reports zeros for an empty journal', () => {
    const quality = computeOnlineQuality([], []);
    expect(quality.decided).toBe(0);
    expect(quality.localFailureRate).toBe(0);
    expect(quality.reliable).toBe(false);
  });

  it('counts only local decisions with feedback towards the failure rate', () => {
    const records = [
      record({ requestId: 'a', actualRoute: 'local' }),
      record({ requestId: 'b', actualRoute: 'local' }),
      record({ requestId: 'c', actualRoute: 'cloud', predictedRoute: 'cloud' }),
    ];
    const entries = [
      feedback({ requestId: 'a', verdict: 'good' }),
      feedback({ requestId: 'b', verdict: 'bad' }),
      feedback({ requestId: 'c', verdict: 'bad' }),
    ];
    const quality = computeOnlineQuality(records, entries);
    expect(quality.decided).toBe(3);
    expect(quality.localDecisions).toBe(2);
    expect(quality.localWithFeedback).toBe(2);
    expect(quality.localRejections).toBe(1);
    expect(quality.localFailureRate).toBe(0.5);
    expect(quality.coverage).toBe(1);
  });

  it('flags the failure rate as unreliable when coverage is too low', () => {
    const records = Array.from({ length: 20 }, (_, index) =>
      record({ requestId: `r${index}` })
    );
    const quality = computeOnlineQuality(records, [feedback({ requestId: 'r0', verdict: 'bad' })]);
    expect(quality.reliable).toBe(false);
    expect(quality.fallbackRate).toBe(0);
  });

  it('computes the fallback rate over local attempts', () => {
    const records = [
      record({ requestId: 'a', fallbackUsed: true, actualRoute: 'cloud' }),
      record({ requestId: 'b' }),
      record({ requestId: 'c', predictedRoute: 'cloud', actualRoute: 'cloud' }),
    ];
    const quality = computeOnlineQuality(records, []);
    expect(quality.localAttempts).toBe(2);
    expect(quality.fallbackCount).toBe(1);
    expect(quality.fallbackRate).toBe(0.5);
  });
});

describe('evaluateCorpus', () => {
  const corpus: LabeledPrompt[] = [
    { prompt: 'Format this function', expectedRoute: 'local' },
    { prompt: 'Refactor this module', expectedRoute: 'cloud' },
    { prompt: 'Refactor this module', expectedRoute: 'local' },
    { prompt: 'Format this function', expectedRoute: 'cloud' },
  ];

  it('builds the confusion matrix at the default threshold', () => {
    const quality = evaluateCorpus(corpus);
    expect(quality.total).toBe(4);
    expect(quality.trueLocal).toBe(1);
    expect(quality.trueCloud).toBe(1);
    expect(quality.falseLocal).toBe(1);
    expect(quality.falseCloud).toBe(1);
    expect(quality.accuracy).toBe(0.5);
    expect(quality.cloudPrecision).toBe(0.5);
    expect(quality.cloudRecall).toBe(0.5);
    expect(quality.cloudF1).toBeCloseTo(0.5);
  });

  it('weights a false-local more heavily than a false-cloud', () => {
    const quality = evaluateCorpus(corpus);
    expect(quality.expectedCost).toBe(
      1 * DEFAULT_COST_MODEL.falseLocalWeight + 1 * DEFAULT_COST_MODEL.falseCloudWeight
    );
  });

  it('routes everything to the cloud at threshold zero', () => {
    const quality = evaluateCorpus(corpus, { threshold: 0 });
    expect(quality.trueCloud).toBe(2);
    expect(quality.falseCloud).toBe(2);
    expect(quality.falseLocal).toBe(0);
  });

  it('handles an empty corpus without dividing by zero', () => {
    const quality = evaluateCorpus([]);
    expect(quality.accuracy).toBe(0);
    expect(quality.expectedCost).toBe(0);
  });
});
