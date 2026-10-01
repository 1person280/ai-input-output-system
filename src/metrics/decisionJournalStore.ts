/**
 * Infrastructure layer: persists the pure {@link DecisionJournal} through the
 * VS Code `globalState` memento. Mirrors {@link MetricsStore} so both analytics
 * aggregates share one persistence pattern.
 */

import * as vscode from 'vscode';
import {
  DecisionFeedback,
  DecisionFeedbackInput,
  DecisionJournal,
  DecisionRecord,
  DecisionRecordInput,
} from '../routing/decisionJournal';

export const JOURNAL_RECORDS_STATE_KEY = 'aiio.decisionJournal.records';
export const JOURNAL_FEEDBACK_STATE_KEY = 'aiio.decisionJournal.feedback';

export class DecisionJournalStore {
  private journal: DecisionJournal;

  constructor(private readonly memento: vscode.Memento) {
    this.journal = new DecisionJournal(this.readPersisted());
  }

  private readPersisted(): { records: DecisionRecord[]; feedback: DecisionFeedback[] } {
    const records = this.memento.get<unknown>(JOURNAL_RECORDS_STATE_KEY);
    const feedback = this.memento.get<unknown>(JOURNAL_FEEDBACK_STATE_KEY);
    return {
      records: Array.isArray(records) ? (records as DecisionRecord[]) : [],
      feedback: Array.isArray(feedback) ? (feedback as DecisionFeedback[]) : [],
    };
  }

  get current(): DecisionJournal {
    return this.journal;
  }

  async recordDecision(input: DecisionRecordInput): Promise<DecisionRecord> {
    const record = this.journal.recordDecision(input);
    await this.persist();
    return record;
  }

  async recordFeedback(input: DecisionFeedbackInput): Promise<boolean> {
    if (!this.journal.attachFeedback(input)) {
      return false;
    }
    await this.persist();
    return true;
  }

  async reset(): Promise<void> {
    this.journal.reset();
    await this.persist();
  }

  /** Reload from disk, e.g. after another window mutated the shared state. */
  async refresh(): Promise<void> {
    this.journal = new DecisionJournal(this.readPersisted());
  }

  private async persist(): Promise<void> {
    const snapshot = this.journal.toJSON();
    await this.memento.update(JOURNAL_RECORDS_STATE_KEY, snapshot.records);
    await this.memento.update(JOURNAL_FEEDBACK_STATE_KEY, snapshot.feedback);
  }
}
