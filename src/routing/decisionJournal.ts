/**
 * Domain layer: the append-only journal of routing decisions and their feedback.
 *
 * This is deliberately separate from {@link SavingsLedger}. The ledger answers
 * "how much cloud traffic did we avoid?"; the journal answers "how often was the
 * routing decision right?". Merging them would give one class two reasons to
 * change.
 *
 * Only one direction of error is observable online: a local answer the user
 * rejects is a confirmed false-local. Whether a cloud answer *could* have been
 * answered locally is a counterfactual we cannot observe, so it is never
 * inferred here — that is exactly what the labelled corpus is for.
 */

import type { RouteKind } from './requestClassifier';

export type FeedbackVerdict = 'good' | 'bad';
export type FeedbackSignal = 'explicit' | 'retry' | 'manual-override';

/** Guard against absurd values from corrupted persisted state. */
const MAX_RECORDS = 20_000;

export interface DecisionRecord {
  requestId: string;
  timestamp: number;
  /** What the routing policy chose before any fallback was applied. */
  predictedRoute: RouteKind;
  /** Where the request was actually answered (cloud after a fallback). */
  actualRoute: RouteKind;
  fallbackUsed: boolean;
  complexity: number;
  threshold: number;
  tokenEstimate: number;
}

export interface DecisionFeedback {
  requestId: string;
  verdict: FeedbackVerdict;
  signal: FeedbackSignal;
  timestamp: number;
}

export interface DecisionRecordInput extends Omit<DecisionRecord, 'timestamp'> {
  timestamp?: number;
}

export interface DecisionFeedbackInput extends Omit<DecisionFeedback, 'timestamp'> {
  timestamp?: number;
}

export interface DecisionJournalSnapshot {
  records: DecisionRecord[];
  feedback: DecisionFeedback[];
}

function isRouteKind(value: unknown): value is RouteKind {
  return value === 'local' || value === 'cloud';
}

function finiteOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitiseRecord(raw: unknown): DecisionRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const entry = raw as Partial<DecisionRecord>;
  if (typeof entry.requestId !== 'string' || entry.requestId.length === 0) {
    return null;
  }
  if (!isRouteKind(entry.predictedRoute) || !isRouteKind(entry.actualRoute)) {
    return null;
  }
  return {
    requestId: entry.requestId,
    timestamp: finiteOr(entry.timestamp, Date.now()),
    predictedRoute: entry.predictedRoute,
    actualRoute: entry.actualRoute,
    fallbackUsed: Boolean(entry.fallbackUsed),
    complexity: finiteOr(entry.complexity, 0),
    threshold: finiteOr(entry.threshold, 0),
    tokenEstimate: Math.max(0, finiteOr(entry.tokenEstimate, 0)),
  };
}

function sanitiseFeedback(raw: unknown): DecisionFeedback | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const entry = raw as Partial<DecisionFeedback>;
  if (typeof entry.requestId !== 'string' || entry.requestId.length === 0) {
    return null;
  }
  if (entry.verdict !== 'good' && entry.verdict !== 'bad') {
    return null;
  }
  const signal: FeedbackSignal =
    entry.signal === 'retry' || entry.signal === 'manual-override'
      ? entry.signal
      : 'explicit';
  return {
    requestId: entry.requestId,
    verdict: entry.verdict,
    signal,
    timestamp: finiteOr(entry.timestamp, Date.now()),
  };
}

export class DecisionJournal {
  private readonly decisions: DecisionRecord[] = [];
  private readonly feedback = new Map<string, DecisionFeedback>();

  constructor(snapshot: Partial<DecisionJournalSnapshot> = {}) {
    for (const raw of snapshot.records ?? []) {
      const record = sanitiseRecord(raw);
      if (record && this.decisions.length < MAX_RECORDS) {
        this.decisions.push(record);
      }
    }
    for (const raw of snapshot.feedback ?? []) {
      const entry = sanitiseFeedback(raw);
      if (entry) {
        this.feedback.set(entry.requestId, entry);
      }
    }
  }

  static fromSnapshot(snapshot: Partial<DecisionJournalSnapshot>): DecisionJournal {
    return new DecisionJournal(snapshot);
  }

  /** Append a decision. Re-recording the same id overwrites it in place. */
  recordDecision(input: DecisionRecordInput): DecisionRecord {
    const record = sanitiseRecord({ timestamp: Date.now(), ...input });
    if (!record) {
      throw new Error('Invalid decision record: requestId and routes are required');
    }
    const existing = this.decisions.findIndex((r) => r.requestId === record.requestId);
    if (existing >= 0) {
      this.decisions[existing] = record;
      return record;
    }
    if (this.decisions.length >= MAX_RECORDS) {
      const evicted = this.decisions.shift();
      if (evicted) {
        this.feedback.delete(evicted.requestId);
      }
    }
    this.decisions.push(record);
    return record;
  }

  /** Attach feedback to a known decision. Returns false for an unknown id. */
  attachFeedback(input: DecisionFeedbackInput): boolean {
    if (!this.decisions.some((record) => record.requestId === input.requestId)) {
      return false;
    }
    const entry = sanitiseFeedback({ timestamp: Date.now(), ...input });
    if (!entry) {
      return false;
    }
    this.feedback.set(entry.requestId, entry);
    return true;
  }

  records(): ReadonlyArray<DecisionRecord> {
    return this.decisions;
  }

  allFeedback(): ReadonlyArray<DecisionFeedback> {
    return Array.from(this.feedback.values());
  }

  recordFor(requestId: string): DecisionRecord | undefined {
    return this.decisions.find((record) => record.requestId === requestId);
  }

  feedbackFor(requestId: string): DecisionFeedback | undefined {
    return this.feedback.get(requestId);
  }

  get size(): number {
    return this.decisions.length;
  }

  reset(): void {
    this.decisions.length = 0;
    this.feedback.clear();
  }

  toJSON(): DecisionJournalSnapshot {
    return {
      records: this.decisions.map((record) => ({ ...record })),
      feedback: this.allFeedback().map((entry) => ({ ...entry })),
    };
  }
}
