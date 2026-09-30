import { describe, expect, it } from 'vitest';
import { SavingsLedger } from './savingsLedger';

describe('SavingsLedger', () => {
  it('reports zero savings when empty', () => {
    const ledger = new SavingsLedger();
    expect(ledger.savingsRatio()).toBe(0);
    expect(ledger.snapshot().totalRequests).toBe(0);
  });

  it('computes the local share of requests', () => {
    const ledger = new SavingsLedger();
    ledger.record('local', 100);
    ledger.record('local', 100);
    ledger.record('cloud', 100);
    ledger.record('cloud', 100);
    expect(ledger.savingsRatio()).toBe(0.5);
  });

  it('aggregates tokens per route', () => {
    const ledger = new SavingsLedger();
    ledger.record('local', 300);
    ledger.record('cloud', 100);
    const snapshot = ledger.snapshot();
    expect(snapshot.localTokens).toBe(300);
    expect(snapshot.cloudTokens).toBe(100);
    expect(snapshot.totalTokens).toBe(400);
    expect(snapshot.tokenSavingsRatio).toBeCloseTo(0.75);
    expect(snapshot.localRequests).toBe(1);
    expect(snapshot.cloudRequests).toBe(1);
  });

  it('estimates the cloud spend avoided', () => {
    const ledger = new SavingsLedger();
    ledger.record('local', 2000);
    expect(ledger.snapshot(0.002).estimatedCloudCostAvoidedUsd).toBeCloseTo(0.004);
    expect(ledger.snapshot(0.01).estimatedCloudCostAvoidedUsd).toBeCloseTo(0.02);
  });

  it('records timestamps and exposes the range', () => {
    const ledger = new SavingsLedger();
    ledger.record('local', 10, 1000);
    ledger.record('cloud', 10, 2000);
    const snapshot = ledger.snapshot();
    expect(snapshot.firstTimestamp).toBe(1000);
    expect(snapshot.lastTimestamp).toBe(2000);
  });

  it('drops malformed persisted entries', () => {
    const ledger = SavingsLedger.fromEntries([
      { timestamp: 1, route: 'local', estimatedTokens: 50 },
      // @ts-expect-error deliberately invalid route from corrupted state
      { timestamp: 2, route: 'edge', estimatedTokens: 50 },
      { timestamp: 3, route: 'cloud', estimatedTokens: -5 },
    ]);
    expect(ledger.size).toBe(1);
    expect(ledger.allEntries()[0].route).toBe('local');
  });

  it('rejects invalid entries passed to record', () => {
    const ledger = new SavingsLedger();
    // @ts-expect-error deliberately invalid route
    expect(() => ledger.record('edge', 10)).toThrow();
  });

  it('round-trips through JSON', () => {
    const ledger = new SavingsLedger();
    ledger.record('local', 42, 7);
    const restored = SavingsLedger.fromEntries(ledger.toJSON());
    expect(restored.snapshot().localTokens).toBe(42);
    expect(restored.snapshot().firstTimestamp).toBe(7);
  });

  it('resets all state', () => {
    const ledger = new SavingsLedger();
    ledger.record('local', 10);
    ledger.reset();
    expect(ledger.size).toBe(0);
    expect(ledger.savingsRatio()).toBe(0);
  });
});