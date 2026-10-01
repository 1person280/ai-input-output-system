/**
 * Extension entry point: composition root.
 *
 * Wires configuration, metrics, model lifecycle, the router and the UI
 * together. All decisions live in the lower layers; this file only assembles
 * and disposes them.
 */

import * as vscode from 'vscode';
import { AutonomousCreator } from './agent/autonomousCreator';
import { CloudClient } from './cloud/cloudClient';
import { onSettingsChanged, readSettings } from './config/settings';
import { LocalModelClient } from './local/localModelClient';
import { defaultModelDirectory, ModelManager } from './local/modelManager';
import { DecisionJournalStore } from './metrics/decisionJournalStore';
import { MetricsStore } from './metrics/metricsStore';
import { computeOnlineQuality, OnlineQuality } from './routing/decisionQuality';
import { Router } from './routing/router';
import { registerCommands } from './ui/commands';
import { getDashboardPanel } from './ui/dashboardPanel';
import { StatusBarController } from './ui/statusBar';

export function activate(context: vscode.ExtensionContext): void {
  let settings = readSettings();

  const metrics = new MetricsStore(context.globalState);
  const journal = new DecisionJournalStore(context.globalState);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const models = new ModelManager(defaultModelDirectory(workspaceRoot));
  const statusBar = new StatusBarController();
  const output = vscode.window.createOutputChannel('AI I/O System');

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
      journal,
      options: {
        threshold: settings.routing.threshold,
        enableLocalRouting: settings.routing.enableLocalRouting,
        fallbackToCloud: true,
        weights: settings.routing.weights,
      },
    });

  // 编排器按当前配置即时组装：本地优先，云端兜底，最后回落到离线启发式。
  const getAutonomousCreator = (): AutonomousCreator =>
    new AutonomousCreator({
      local: new LocalModelClient({ serverUrl: settings.local.serverUrl }),
      cloud: new CloudClient({
        baseUrl: settings.cloud.baseUrl,
        apiKey: settings.cloud.apiKey,
        model: settings.cloud.model,
      }),
      output,
      targetSubdirectory: settings.autonomous.targetSubdirectory,
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri,
    });

  const getRoutingQuality = (): OnlineQuality =>
    computeOnlineQuality(journal.current.records(), journal.current.allFeedback());

  const refreshViews = (): void => {
    const ledger = metrics.current;
    const snapshot = ledger.snapshot();
    statusBar.update(snapshot);
    getDashboardPanel()?.update(snapshot, ledger.allEntries(), getRoutingQuality());
  };

  registerCommands(context, {
    metrics,
    models,
    getSettings: () => settings,
    getRouter,
    getAutonomousCreator,
    recordFeedback: async (requestId, verdict) => {
      await journal.recordFeedback({ requestId, verdict, signal: 'explicit' });
    },
    getRoutingQuality,
    refreshViews,
  });

  context.subscriptions.push(
    statusBar,
    models,
    output,
    onSettingsChanged((next) => {
      settings = next;
      refreshViews();
    })
  );

  refreshViews();

  void probeLocalServer(settings.local.serverUrl);

  if (settings.autonomous.onStartup && settings.autonomous.requirement.trim().length > 0) {
    void runStartupCreation(
      getAutonomousCreator,
      settings.autonomous.requirement.trim()
    );
  }
}

/** 激活时的自主创建：失败只提示，绝不阻塞扩展启动。 */
async function runStartupCreation(
  getCreator: () => AutonomousCreator,
  requirement: string
): Promise<void> {
  try {
    const plan = await getCreator().createFilesFromRequirement(requirement);
    void vscode.window.showInformationMessage(
      `AI I/O 已依据启动需求创建 ${plan.files.length} 个文件（来源：${plan.source}）。`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`AI I/O 启动自动创建失败：${message}`);
  }
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