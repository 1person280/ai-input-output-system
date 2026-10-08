/**
 * Domain layer: pure savings accounting.
 *
 * Every routed request appends one entry. The ledger answers the product
 * question — "how much cloud traffic did we avoid?" — without knowing anything
 * about VS Code or the network.
 */

import type { RouteKind } from '../routing/requestClassifier';

export interface LedgerEntry {
  timestamp: number;
  route: RouteKind;
  estimatedTokens: number;
}

export interface LedgerSnapshot {
  totalRequests: number;
  localRequests: number;
  cloudRequests: number;
  localTokens: number;
  cloudTokens: number;
  totalTokens: number;
  /** Share of requests answered locally, 0..1. */
  savingsRatio: number;
  /** Share of estimated tokens kept off the cloud, 0..1. */
  tokenSavingsRatio: number;
  /** Estimated USD avoided, given a per-1K-token cloud price. */
  estimatedCloudCostAvoidedUsd: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
}

export const DEFAULT_CLOUD_USD_PER_1K_TOKENS = 0.002;

/** Guard against absurd values from corrupted persisted state. */
const MAX_TOKENS_PER_ENTRY = 10_000_000;
const MAX_ENTRIES = 100_000;

function sanitiseEntry(entry: LedgerEntry): LedgerEntry | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  if (entry.route !== 'local' && entry.route !== 'escalated' && entry.route !== 'cloud') {
    return null;
  }
  const tokens = Number(entry.estimatedTokens);
  if (!Number.isFinite(tokens) || tokens < 0) {
    return null;
  }
  const timestamp = Number(entry.timestamp);
  return {
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    route: entry.route,
    estimatedTokens: Math.min(tokens, MAX_TOKENS_PER_ENTRY),
  };
}

export class SavingsLedger {
  private records: LedgerEntry[] = [];

  constructor(entries: ReadonlyArray<LedgerEntry> = []) {
    for (const entry of entries) {
      const clean = sanitiseEntry(entry);
      if (clean && this.records.length < MAX_ENTRIES) {
        this.records.push(clean);
      }
    }
  }

  static fromEntries(entries: ReadonlyArray<LedgerEntry>): SavingsLedger {
    return new SavingsLedger(entries);
  }

  /** Append a decision. Returns the stored entry. */
  record(
    route: RouteKind,
    estimatedTokens: number,
    timestamp: number = Date.now()
  ): LedgerEntry {
    const clean = sanitiseEntry({ route, estimatedTokens, timestamp });
    if (!clean) {
      throw new Error('Invalid ledger entry: route and tokens are required');
    }
    if (this.records.length >= MAX_ENTRIES) {
      this.records.shift();
    }
    this.records.push(clean);
    return clean;
  }

  allEntries(): ReadonlyArray<LedgerEntry> {
    return this.records;
  }

  get size(): number {
    return this.records.length;
  }

  /** Share of requests answered without any cloud involvement. Zero when empty. */
  savingsRatio(): number {
    if (this.records.length === 0) {
      return 0;
    }
    const localCount = this.records.filter((r) => r.route === 'local').length;
    return localCount / this.records.length;
  }

  tokenSavingsRatio(): number {
    const totals = this.totals();
    if (totals.totalTokens === 0) {
      return 0;
    }
    return totals.localTokens / totals.totalTokens;
  }

  private totals(): {
    localTokens: number;
    cloudTokens: number;
    totalTokens: number;
  } {
    let localTokens = 0;
    let cloudTokens = 0;
    for (const entry of this.records) {
      if (entry.route === 'local') {
        localTokens += entry.estimatedTokens;
      } else {
        cloudTokens += entry.estimatedTokens;
      }
    }
    return { localTokens, cloudTokens, totalTokens: localTokens + cloudTokens };
  }

  snapshot(
    usdPer1kTokens: number = DEFAULT_CLOUD_USD_PER_1K_TOKENS
  ): LedgerSnapshot {
    const { localTokens, cloudTokens, totalTokens } = this.totals();
    const localRequests = this.records.filter((r) => r.route === 'local').length;
    const cloudRequests = this.records.length - localRequests;
    const price = Number.isFinite(usdPer1kTokens)
      ? Math.max(0, usdPer1kTokens)
      : DEFAULT_CLOUD_USD_PER_1K_TOKENS;

    return {
      totalRequests: this.records.length,
      localRequests,
      cloudRequests,
      localTokens,
      cloudTokens,
      totalTokens,
      savingsRatio: this.savingsRatio(),
      tokenSavingsRatio: totalTokens === 0 ? 0 : localTokens / totalTokens,
      estimatedCloudCostAvoidedUsd: (localTokens / 1000) * price,
      firstTimestamp: this.records.length ? this.records[0].timestamp : null,
      lastTimestamp: this.records.length
        ? this.records[this.records.length - 1].timestamp
        : null,
    };
  }

  /** Plain data used for `globalState` persistence. */
  toJSON(): LedgerEntry[] {
    return this.records.map((entry) => ({ ...entry }));
  }

  reset(): void {
    this.records = [];
  }
}