/**
 * Extension entry point: composition root.
 *
 * Wires configuration, metrics, model lifecycle, the router and the UI
 * together. All decisions live in the lower layers; this file only assembles
 * and disposes them.
 */

import * as vscode from 'vscode';
import { CloudClient } from './cloud/cloudClient';
import { onSettingsChanged, readSettings } from './config/settings';
import { LocalModelClient } from './local/localModelClient';
import { defaultModelDirectory, ModelManager } from './local/modelManager';
import { MetricsStore } from './metrics/metricsStore';
import { Router } from './routing/router';
import { registerCommands } from './ui/commands';
import { getDashboardPanel } from './ui/dashboardPanel';
import { StatusBarController } from './ui/statusBar';

export function activate(context: vscode.ExtensionContext): void {
  let settings = readSettings();

  const metrics = new MetricsStore(context.globalState);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const models = new ModelManager(defaultModelDirectory(workspaceRoot));
  const statusBar = new StatusBarController();

  const getRouter = (): Router =>
    new Router({
      cloud: new CloudClient({
        baseUrl: settings.cloud.baseUrl,
        apiKey: settings.cloud.apiKey,
        model: settings.cloud.model,
      }),
      local: settings.routing.enableLocalRouting
        ? new LocalModelClient({ serverUrl: settings.local.serverUrl })
        : null,
      ledger: metrics,
      options: {
        threshold: settings.routing.threshold,
        enableLocalRouting: settings.routing.enableLocalRouting,
        fallbackToCloud: true,
      },
    });

  const refreshViews = (): void => {
    const ledger = metrics.current;
    const snapshot = ledger.snapshot();
    statusBar.update(snapshot);
    getDashboardPanel()?.update(snapshot, ledger.allEntries());
  };

  registerCommands(context, {
    metrics,
    models,
    getSettings: () => settings,
    getRouter,
    refreshViews,
  });

  context.subscriptions.push(
    statusBar,
    models,
    onSettingsChanged((next) => {
      settings = next;
      refreshViews();
    })
  );

  refreshViews();

  void probeLocalServer(settings.local.serverUrl);
}

async function probeLocalServer(serverUrl: string): Promise<void> {
  const available = await new LocalModelClient({ serverUrl }).isAvailable();
  if (!available) {
    console.info(
      `[aiio] No llama-server at ${serverUrl}. Simple prompts will fall back to the cloud until it is started.`
    );
  }
}

export function deactivate(): void {
  // Children and disposables are released through context.subscriptions.
}