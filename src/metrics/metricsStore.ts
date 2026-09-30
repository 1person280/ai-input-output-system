/**
 * Infrastructure layer: persists the pure {@link SavingsLedger} through the
 * VS Code `globalState` memento.
 */

import * as vscode from 'vscode';
import type { RouteKind } from '../routing/requestClassifier';
import { LedgerEntry, SavingsLedger } from './savingsLedger';

export const LEDGER_STATE_KEY = 'aiio.savingsLedger.entries';

export class MetricsStore {
  private ledger: SavingsLedger;

  constructor(private readonly memento: vscode.Memento) {
    this.ledger = new SavingsLedger(this.readPersisted());
  }

  private readPersisted(): LedgerEntry[] {
    const raw = this.memento.get<unknown>(LEDGER_STATE_KEY);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw as LedgerEntry[];
  }

  get current(): SavingsLedger {
    return this.ledger;
  }

  async record(route: RouteKind, estimatedTokens: number): Promise<LedgerEntry> {
    const entry = this.ledger.record(route, estimatedTokens);
    await this.persist();
    return entry;
  }

  async reset(): Promise<void> {
    this.ledger.reset();
    await this.persist();
  }

  /** Reload from disk, e.g. after another window mutated the shared state. */
  async refresh(): Promise<void> {
    this.ledger = new SavingsLedger(this.readPersisted());
  }

  private async persist(): Promise<void> {
    await this.memento.update(LEDGER_STATE_KEY, this.ledger.toJSON());
  }
}