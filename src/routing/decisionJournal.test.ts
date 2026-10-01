import { describe, expect, it } from 'vitest';
import { DecisionJournal } from './decisionJournal';

function recordInput(requestId: string) {
  return {
    requestId,
    predictedRoute: 'local' as const,
    actualRoute: 'local' as const,
    fallbackUsed: false,
    complexity: 0.2,
    threshold: 0.5,
    tokenEstimate: 120,
    latencyMs: 800,
  };
}

describe('DecisionJournal', () => {
  it('starts empty', () => {
    const journal = new DecisionJournal();
    expect(journal.size).toBe(0);
    expect(journal.records()).toEqual([]);
  });

  it('records decisions and keeps the insertion order', () => {
    const journal = new DecisionJournal();
    journal.recordDecision(recordInput('a'));
    journal.recordDecision(recordInput('b'));
    expect(journal.size).toBe(2);
    expect(journal.records().map((r) => r.requestId)).toEqual(['a', 'b']);
  });

  it('overwrites rather than duplicating a repeated request id', () => {
    const journal = new DecisionJournal();
    journal.recordDecision(recordInput('a'));
    journal.recordDecision({ ...recordInput('a'), actualRoute: 'cloud', fallbackUsed: true });
    expect(journal.size).toBe(1);
    expect(journal.recordFor('a')?.actualRoute).toBe('cloud');
  });

  it('rejects feedback for an unknown request id', () => {
    const journal = new DecisionJournal();
    expect(
      journal.attachFeedback({ requestId: 'ghost', verdict: 'bad', signal: 'explicit' })
    ).toBe(false);
  });

  it('attaches feedback to a known decision', () => {
    const journal = new DecisionJournal();
    journal.recordDecision(recordInput('a'));
    expect(
      journal.attachFeedback({ requestId: 'a', verdict: 'bad', signal: 'explicit' })
    ).toBe(true);
    expect(journal.feedbackFor('a')?.verdict).toBe('bad');
    expect(journal.allFeedback()).toHaveLength(1);
  });

  it('round-trips through a snapshot and drops malformed entries', () => {
    const journal = new DecisionJournal({
      records: [
        recordInput('a') as never,
        { requestId: '', predictedRoute: 'local', actualRoute: 'local' } as never,
        { nonsense: true } as never,
      ],
      feedback: [
        { requestId: 'a', verdict: 'good', signal: 'explicit', timestamp: 1 },
        { requestId: 'a', verdict: 'maybe' as never, signal: 'explicit', timestamp: 1 },
      ],
    });
    expect(journal.size).toBe(1);

    const restored = DecisionJournal.fromSnapshot(journal.toJSON());
    expect(restored.size).toBe(1);
    expect(restored.feedbackFor('a')?.verdict).toBe('good');
  });
});
