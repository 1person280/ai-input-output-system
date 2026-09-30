/**
 * Presentation layer: the status-bar readout of the local/cloud split.
 */

import * as vscode from 'vscode';
import type { LedgerSnapshot } from '../metrics/savingsLedger';

export const SHOW_DASHBOARD_COMMAND = 'aiio.showDashboard';

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(tokens);
}

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = SHOW_DASHBOARD_COMMAND;
    this.render({
      totalRequests: 0,
      localRequests: 0,
      cloudRequests: 0,
      localTokens: 0,
      cloudTokens: 0,
      totalTokens: 0,
      savingsRatio: 0,
      tokenSavingsRatio: 0,
      estimatedCloudCostAvoidedUsd: 0,
      firstTimestamp: null,
      lastTimestamp: null,
    });
    this.item.show();
  }

  update(snapshot: LedgerSnapshot): void {
    this.render(snapshot);
  }

  private render(snapshot: LedgerSnapshot): void {
    const percent = Math.round(snapshot.savingsRatio * 100);
    this.item.text = `$(dashboard) AI I/O · ${percent}% local`;

    const tooltip = new vscode.MarkdownString(
      [
        '**AI Input/Output System**',
        '',
        `Routed requests: ${snapshot.totalRequests} (local ${snapshot.localRequests} / cloud ${snapshot.cloudRequests})`,
        `Local share: ${percent}% · token share: ${Math.round(snapshot.tokenSavingsRatio * 100)}%`,
        `Cloud tokens avoided: ${formatTokens(snapshot.localTokens)} of ${formatTokens(snapshot.totalTokens)}`,
        `Estimated cloud spend avoided: $${snapshot.estimatedCloudCostAvoidedUsd.toFixed(4)}`,
        '',
        '_Click to open the savings dashboard._',
      ].join('\n')
    );
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    this.item.dispose();
  }
}