/**
 * Presentation layer: a dependency-free webview dashboard.
 *
 * Everything is inline HTML + CSS + SVG (no frontend framework, no scripts),
 * so the panel works under a strict Content-Security-Policy.
 */

import * as vscode from 'vscode';
import type { LedgerEntry, LedgerSnapshot } from '../metrics/savingsLedger';

export const DASHBOARD_VIEW_TYPE = 'aiio.dashboard';
const RECENT_LIMIT = 10;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(tokens);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function renderSplitBar(snapshot: LedgerSnapshot): string {
  const width = 600;
  const height = 48;
  const localWidth = Math.round(snapshot.savingsRatio * width);
  const cloudWidth = width - localWidth;
  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Local versus cloud request split" style="width:100%;height:auto;">
      <rect x="0" y="0" width="${localWidth}" height="${height}" rx="8" fill="#2ea043" />
      <rect x="${localWidth}" y="0" width="${cloudWidth}" height="${height}" rx="8" fill="#8957e5" />
      <text x="12" y="30" fill="#ffffff" font-size="16" font-family="sans-serif">local ${percent(snapshot.savingsRatio)}</text>
      <text x="${width - 12}" y="30" fill="#ffffff" font-size="16" font-family="sans-serif" text-anchor="end">cloud ${percent(1 - snapshot.savingsRatio)}</text>
    </svg>`;
}

function renderCard(label: string, value: string, hint: string): string {
  return `
    <div class="card">
      <div class="card-label">${escapeHtml(label)}</div>
      <div class="card-value">${escapeHtml(value)}</div>
      <div class="card-hint">${escapeHtml(hint)}</div>
    </div>`;
}

function renderRecent(entries: ReadonlyArray<LedgerEntry>): string {
  if (entries.length === 0) {
    return '<p class="empty">No requests routed yet. Run “AI I/O: Route Prompt” to get started.</p>';
  }
  const rows = entries
    .slice(-RECENT_LIMIT)
    .reverse()
    .map((entry) => {
      const when = new Date(entry.timestamp).toLocaleString();
      const badge = entry.route === 'local' ? 'badge-local' : 'badge-cloud';
      return `<tr><td>${escapeHtml(when)}</td><td><span class="${badge}">${entry.route}</span></td><td>${entry.estimatedTokens}</td></tr>`;
    })
    .join('');
  return `
    <table>
      <thead><tr><th>When</th><th>Route</th><th>Est. tokens</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export function renderDashboardHtml(
  snapshot: LedgerSnapshot,
  recent: ReadonlyArray<LedgerEntry> = []
): string {
  const cards = [
    renderCard('Local share', percent(snapshot.savingsRatio), 'requests answered without the cloud'),
    renderCard('Requests routed', String(snapshot.totalRequests), `${snapshot.localRequests} local · ${snapshot.cloudRequests} cloud`),
    renderCard('Cloud tokens avoided', formatTokens(snapshot.localTokens), `${percent(snapshot.tokenSavingsRatio)} of ${formatTokens(snapshot.totalTokens)} tokens`),
    renderCard('Estimated spend avoided', `$${snapshot.estimatedCloudCostAvoidedUsd.toFixed(4)}`, 'at $0.002 / 1K tokens'),
  ].join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>AI Input/Output System</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-foreground, #1f2328);
    background: var(--vscode-editor-background, #ffffff);
    padding: 20px; margin: 0;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { opacity: 0.7; margin: 0 0 20px; font-size: 13px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { border: 1px solid var(--vscode-panel-border, #d0d7de); border-radius: 10px; padding: 12px 14px; }
  .card-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.65; }
  .card-value { font-size: 26px; font-weight: 600; margin: 6px 0 2px; }
  .card-hint { font-size: 12px; opacity: 0.6; }
  h2 { font-size: 15px; margin: 22px 0 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, #d0d7de); }
  th { opacity: 0.7; font-weight: 600; }
  .badge-local, .badge-cloud { padding: 1px 8px; border-radius: 999px; font-size: 12px; color: #fff; }
  .badge-local { background: #2ea043; }
  .badge-cloud { background: #8957e5; }
  .empty { opacity: 0.6; font-size: 13px; }
</style>
</head>
<body>
  <h1>AI Input/Output System</h1>
  <p class="subtitle">Local-first routing: simple prompts stay on-device, only complex work reaches the cloud.</p>
  <div class="cards">${cards}</div>
  <h2>Request split</h2>
  ${renderSplitBar(snapshot)}
  <h2>Recent decisions</h2>
  ${renderRecent(recent)}
</body>
</html>`;
}

export class DashboardPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  static createOrShow(): DashboardPanel {
    const instance = new DashboardPanel();
    instance.panel = vscode.window.createWebviewPanel(
      DASHBOARD_VIEW_TYPE,
      'AI Input/Output System',
      vscode.ViewColumn.Two,
      { enableScripts: false, retainContextWhenHidden: true }
    );
    instance.panel.onDidDispose(() => {
      instance.panel = undefined;
    });
    return instance;
  }

  get isVisible(): boolean {
    return Boolean(this.panel);
  }

  update(snapshot: LedgerSnapshot, recent: ReadonlyArray<LedgerEntry> = []): void {
    if (!this.panel) {
      return;
    }
    this.panel.webview.html = renderDashboardHtml(snapshot, recent);
  }

  reveal(): void {
    this.panel?.reveal();
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}

let currentPanel: DashboardPanel | undefined;

/** Reuse the live panel when possible, otherwise open a fresh one. */
export function showDashboardPanel(): DashboardPanel {
  if (currentPanel?.isVisible) {
    currentPanel.reveal();
    return currentPanel;
  }
  currentPanel = DashboardPanel.createOrShow();
  return currentPanel;
}

export function getDashboardPanel(): DashboardPanel | undefined {
  return currentPanel;
}