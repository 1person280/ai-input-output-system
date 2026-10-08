/**
 * Presentation layer: the interactive savings dashboard.
 *
 * Unlike the previous read-only page, the webview now hosts a toolbar with
 * live actions (test connections, reconfigure the cloud endpoint, open
 * settings, reset the ledger). State is pushed through `postMessage`, so
 * updates never re-create the HTML and the user's scroll position is kept.
 * Rendering stays inline JS with no framework, under a strict CSP.
 */

import * as vscode from 'vscode';
import type { LedgerEntry, LedgerSnapshot } from '../metrics/savingsLedger';
import type { AdaptiveThreshold } from '../routing/adaptiveThreshold';
import type { OnlineQuality } from '../routing/decisionQuality';
import { renderRoutingQualitySection } from './routingQualitySection';

export const DASHBOARD_VIEW_TYPE = 'aiio.dashboard';
const RECENT_LIMIT = 10;

/** Reachability of both back-ends, as probed on demand. */
export interface DashboardConnectionStatus {
  cloud: {
    ok: boolean;
    error?: string;
    models: string[];
    endpoint: string;
    model: string;
  };
  local: {
    available: boolean;
    endpoint: string;
  };
}

/** Backing services the dashboard's toolbar buttons may invoke. */
export interface DashboardHandlers {
  /** Reset the ledger and re-render everything. */
  resetMetrics(): void | Promise<void>;
  /** Probe the cloud endpoint and the local server. */
  testConnections(): Promise<DashboardConnectionStatus>;
  /** Walk the user through cloud configuration. */
  configure(): void | Promise<void>;
}

export interface DashboardState {
  snapshot: LedgerSnapshot;
  recent: ReadonlyArray<LedgerEntry>;
  quality: OnlineQuality | null;
  adaptive: AdaptiveThreshold | null;
  /** Pre-rendered "routing quality" block (server-side, testable). */
  qualityHtml: string;
  /** Last connection probe result, or null before the first test. */
  connections: DashboardConnectionStatus | null;
}

function toDashboardState(
  snapshot: LedgerSnapshot,
  recent: ReadonlyArray<LedgerEntry>,
  quality: OnlineQuality | null,
  adaptive: AdaptiveThreshold | null,
  connections: DashboardConnectionStatus | null
): DashboardState {
  return {
    snapshot,
    recent: recent.slice(-RECENT_LIMIT),
    quality,
    adaptive,
    qualityHtml: renderRoutingQualitySection(quality, adaptive),
    connections,
  };
}

export class DashboardPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private connections: DashboardConnectionStatus | null = null;

  private constructor(
    private readonly handlers: DashboardHandlers
  ) {}

  static createOrShow(handlers: DashboardHandlers): DashboardPanel {
    const instance = new DashboardPanel(handlers);
    instance.panel = vscode.window.createWebviewPanel(
      DASHBOARD_VIEW_TYPE,
      'AI Input/Output System',
      vscode.ViewColumn.Two,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    instance.panel.webview.html = renderDashboardHtml(
      instance.panel.webview.cspSource
    );
    instance.panel.webview.onDidReceiveMessage((message) =>
      void instance.handle(message)
    );
    instance.panel.onDidDispose(() => {
      instance.panel = undefined;
    });
    return instance;
  }

  get isVisible(): boolean {
    return Boolean(this.panel);
  }

  update(
    snapshot: LedgerSnapshot,
    recent: ReadonlyArray<LedgerEntry> = [],
    quality: OnlineQuality | null = null,
    adaptive: AdaptiveThreshold | null = null
  ): void {
    if (!this.panel) {
      return;
    }
    void this.panel.webview.postMessage({
      type: 'state',
      state: toDashboardState(snapshot, recent, quality, adaptive, this.connections),
    });
  }

  /** Push a fresh connection-probe result into the toolbar readout. */
  setConnections(status: DashboardConnectionStatus): void {
    this.connections = status;
    if (!this.panel) {
      return;
    }
    void this.panel.webview.postMessage({ type: 'connections', connections: status });
  }

  reveal(): void {
    this.panel?.reveal();
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private async handle(message: unknown): Promise<void> {
    const msg = message as { type?: string } | null;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    switch (msg.type) {
      case 'test':
        try {
          const status = await this.handlers.testConnections();
          this.setConnections(status);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          void this.panel?.webview.postMessage({
            type: 'toast',
            text: `探测失败：${detail}`,
          });
        }
        break;
      case 'reset':
        try {
          await this.handlers.resetMetrics();
          void this.panel?.webview.postMessage({
            type: 'toast',
            text: '统计已重置。',
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          void this.panel?.webview.postMessage({ type: 'toast', text: detail });
        }
        break;
      case 'configure':
        await this.handlers.configure();
        break;
      case 'open-settings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'aiio.');
        break;
      default:
        break;
    }
  }
}

let currentPanel: DashboardPanel | undefined;

/** Reuse the live panel when possible, otherwise open a fresh one. */
export function showDashboardPanel(handlers: DashboardHandlers): DashboardPanel {
  if (currentPanel?.isVisible) {
    currentPanel.reveal();
    return currentPanel;
  }
  currentPanel = DashboardPanel.createOrShow(handlers);
  return currentPanel;
}

export function getDashboardPanel(): DashboardPanel | undefined {
  return currentPanel;
}

function renderDashboardHtml(cspSource: string): string {
  // 内联脚本必须带 nonce 才能通过 webview 的 CSP；否则脚本被静默拦截，
  // 工具栏按钮（测试连接/重置统计…）全部失效。
  const nonce = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  ).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-foreground, #1f2328);
    background: var(--vscode-editor-background, #ffffff);
    padding: 20px; margin: 0;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { opacity: 0.7; margin: 0 0 16px; font-size: 13px; }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
  .toolbar button {
    background: var(--vscode-button-secondaryBackground, #e5e7eb);
    color: var(--vscode-button-secondaryForeground, #1f2328);
    border: none; border-radius: 6px; padding: 5px 12px; font-size: 12.5px; cursor: pointer;
  }
  .toolbar button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, #d1d5db); }
  .toolbar button.danger { color: #cf222e; border: 1px solid #cf222e; background: transparent; }
  .toolbar button:disabled { opacity: 0.5; cursor: default; }
  .conn { font-size: 12.5px; margin: 0 0 20px; line-height: 1.6; }
  .conn .ok { color: #2ea043; }
  .conn .err { color: #cf222e; }
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
  #toast { font-size: 12.5px; min-height: 16px; margin: 0 0 12px; opacity: 0.8; }
</style>
</head>
<body>
  <h1>AI Input/Output System</h1>
  <p class="subtitle">本地优先路由：简单请求留在设备上，复杂工作才去云端。</p>
  <div class="toolbar">
    <button id="btn-test">测试连接</button>
    <button id="btn-configure">配置云端…</button>
    <button id="btn-settings">打开设置</button>
    <button id="btn-reset" class="danger">重置统计</button>
  </div>
  <p id="toast"></p>
  <div id="conn" class="conn">尚未探测。点「测试连接」检查云端端点与本地 llama-server 的可用性。</div>
  <div class="cards" id="cards"></div>
  <h2>Request split</h2>
  <div id="split"></div>
  <h2>Routing quality</h2>
  <div id="quality"></div>
  <h2>Recent decisions</h2>
  <div id="recent"></div>
<script nonce="${nonce}">
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var els = {
    cards: document.getElementById('cards'),
    split: document.getElementById('split'),
    quality: document.getElementById('quality'),
    recent: document.getElementById('recent'),
    conn: document.getElementById('conn'),
    toast: document.getElementById('toast')
  };
  var btnTest = document.getElementById('btn-test');
  var btnReset = document.getElementById('btn-reset');

  function toast(text) {
    els.toast.textContent = text;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { els.toast.textContent = ''; }, 3000);
  }

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTokens(tokens) {
    if (tokens >= 1e6) { return (tokens / 1e6).toFixed(2) + 'M'; }
    if (tokens >= 1e3) { return (tokens / 1e3).toFixed(1) + 'K'; }
    return String(tokens);
  }

  function pct(value) { return Math.round(value * 100) + '%'; }

  function card(label, value, hint) {
    return '<div class="card"><div class="card-label">' + esc(label) +
      '</div><div class="card-value">' + esc(value) +
      '</div><div class="card-hint">' + esc(hint) + '</div></div>';
  }

  function splitBar(snapshot) {
    var width = 600, height = 48;
    var localWidth = Math.round(snapshot.savingsRatio * width);
    return '<svg viewBox="0 0 ' + width + ' ' + height + '" style="width:100%;height:auto;">' +
      '<rect x="0" y="0" width="' + localWidth + '" height="' + height + '" rx="8" fill="#2ea043" />' +
      '<rect x="' + localWidth + '" y="0" width="' + (width - localWidth) + '" height="' + height + '" rx="8" fill="#8957e5" />' +
      '<text x="12" y="30" fill="#fff" font-size="16">local ' + pct(snapshot.savingsRatio) + '</text>' +
      '<text x="' + (width - 12) + '" y="30" fill="#fff" font-size="16" text-anchor="end">cloud ' + pct(1 - snapshot.savingsRatio) + '</text>' +
      '</svg>';
  }

  function recentTable(entries) {
    if (!entries.length) {
      return '<p class="empty">还没有路由记录。运行「AI I/O: Route Prompt」或使用侧边栏 AI 助手开始。</p>';
    }
    var rows = entries.slice().reverse().map(function (entry) {
      var when = new Date(entry.timestamp).toLocaleString();
      var cls = entry.route === 'local' ? 'badge-local' : 'badge-cloud';
      return '<tr><td>' + esc(when) + '</td><td><span class="' + cls + '">' + esc(entry.route) +
        '</span></td><td>' + entry.estimatedTokens + '</td></tr>';
    }).join('');
    return '<table><thead><tr><th>When</th><th>Route</th><th>Est. tokens</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  function renderConn(conn) {
    if (!conn) { return; }
    var cloud = conn.cloud;
    var local = conn.local;
    var cloudLine = cloud.ok
      ? '<span class="ok">✓ 云端可用</span> — ' + esc(cloud.endpoint) + ' · 模型 ' + esc(cloud.model) +
        (cloud.models.length ? '（端点共列出 ' + cloud.models.length + ' 个模型）' : '')
      : '<span class="err">✗ 云端不可用</span> — ' + esc(cloud.endpoint) +
        (cloud.error ? '（' + esc(cloud.error) + '）' : '');
    var localLine = local.available
      ? '<span class="ok">✓ 本地 llama-server 可用</span> — ' + esc(local.endpoint)
      : '<span class="err">✗ 本地 llama-server 不可达</span> — ' + esc(local.endpoint) + '（可选，缺失时全部走云端）';
    els.conn.innerHTML = cloudLine + '<br>' + localLine;
  }

  function renderState(state) {
    var s = state.snapshot;
    els.cards.innerHTML = [
      card('Local share', pct(s.savingsRatio), 'requests answered without the cloud'),
      card('Requests routed', String(s.totalRequests), s.localRequests + ' local · ' + s.cloudRequests + ' cloud'),
      card('Cloud tokens avoided', fmtTokens(s.localTokens), pct(s.tokenSavingsRatio) + ' of ' + fmtTokens(s.totalTokens) + ' tokens'),
      card('Estimated spend avoided', '$' + s.estimatedCloudCostAvoidedUsd.toFixed(4), 'at $0.002 / 1K tokens')
    ].join('');
    els.split.innerHTML = splitBar(s);
    els.quality.innerHTML = state.qualityHtml;
    els.recent.innerHTML = recentTable(state.recent);
  }

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || !message.type) { return; }
    switch (message.type) {
      case 'state':
        renderState(message.state);
        if (message.state.connections) { renderConn(message.state.connections); }
        break;
      case 'connections':
        renderConn(message.connections);
        break;
      case 'toast':
        toast(message.text);
        break;
      default:
        break;
    }
  });

  btnTest.addEventListener('click', function () {
    btnTest.disabled = true;
    els.conn.textContent = '探测中…';
    vscode.postMessage({ type: 'test' });
    setTimeout(function () { btnTest.disabled = false; }, 3000);
  });
  btnReset.addEventListener('click', function () {
    if (window.confirm('确定要清空全部路由统计吗？此操作不可撤销。')) {
      vscode.postMessage({ type: 'reset' });
    }
  });
  document.getElementById('btn-configure').addEventListener('click', function () {
    vscode.postMessage({ type: 'configure' });
  });
  document.getElementById('btn-settings').addEventListener('click', function () {
    vscode.postMessage({ type: 'open-settings' });
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
