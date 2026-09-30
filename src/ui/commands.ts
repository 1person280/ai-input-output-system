/**
 * Presentation layer: command registration and user-facing flows.
 */

import * as vscode from 'vscode';
import { ExtensionSettings } from '../config/settings';
import { buildDownloadCommand, ModelManager } from '../local/modelManager';
import { MetricsStore } from '../metrics/metricsStore';
import type { EditorContext } from '../routing/requestClassifier';
import { Router } from '../routing/router';
import { showDashboardPanel } from './dashboardPanel';
import { SHOW_DASHBOARD_COMMAND } from './statusBar';

export const ROUTE_PROMPT_COMMAND = 'aiio.routePrompt';
export const MANAGE_MODEL_COMMAND = 'aiio.manageModel';
export { SHOW_DASHBOARD_COMMAND };

export interface CommandServices {
  metrics: MetricsStore;
  models: ModelManager;
  getSettings(): ExtensionSettings;
  getRouter(): Router;
  /** Re-render the status bar and dashboard after a mutation. */
  refreshViews(): void;
}

function collectEditorContext(editor: vscode.TextEditor | undefined): EditorContext {
  if (!editor) {
    return {};
  }
  const selection = editor.document.getText(editor.selection);
  const openTabCount = vscode.window.tabGroups.all.reduce(
    (total, group) => total + group.tabs.length,
    0
  );
  return {
    fileName: vscode.workspace.asRelativePath(editor.document.uri),
    languageId: editor.document.languageId,
    selectedText: selection.trim().length > 0 ? selection : undefined,
    fileCount: Math.max(1, openTabCount),
  };
}

async function showAnswer(content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    content,
    language: 'markdown',
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function routePrompt(services: CommandServices): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const prompt = await vscode.window.showInputBox({
    title: 'AI I/O · Route Prompt',
    prompt: 'Ask anything. Simple requests stay local; complex ones go to the cloud.',
    placeHolder: 'e.g. Format this function / Refactor this module for testability',
    ignoreFocusOut: true,
  });
  if (!prompt || prompt.trim().length === 0) {
    return;
  }

  const context = collectEditorContext(editor);
  const router = services.getRouter();
  const preview = router.preview(prompt, context);

  try {
    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `AI I/O · asking the ${preview.decision.route} model…`,
        cancellable: true,
      },
      async (_progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        return router.route(prompt, context, abort.signal);
      }
    );

    services.refreshViews();

    const header = [
      `# AI I/O answer`,
      '',
      `- route: **${outcome.route}**${outcome.fallbackUsed ? ' (fallback from local)' : ''}`,
      `- complexity: ${outcome.features.complexity.toFixed(2)} vs threshold ${outcome.decision.threshold.toFixed(2)}`,
      `- reason: ${outcome.decision.reason}`,
      `- est. tokens: ${outcome.features.estimatedTokens} · latency: ${outcome.latencyMs} ms`,
      `- model: ${outcome.completion.model}`,
      '',
      '---',
      '',
    ].join('\n');

    await showAnswer(`${header}${outcome.completion.text}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`AI I/O routing failed: ${message}`);
  }
}

async function manageModel(services: CommandServices): Promise<void> {
  const settings = services.getSettings();
  const status = await services.models.inspect(settings.local.modelPath);

  const actions = [
    {
      label: '$(cloud-download) Show download instructions',
      detail: buildDownloadCommand(services.models.spec),
    },
    {
      label: '$(play) Start local server',
      detail: `llama-server --ctx-size ${status.spec.contextTokens} -ngl 99`,
    },
    { label: '$(debug-stop) Stop local server', detail: 'Terminate the child process' },
    { label: '$(folder-opened) Reveal model path', detail: status.path },
  ];

  const choice = await vscode.window.showQuickPick(actions, {
    title: `AI I/O · local model (${status.present ? 'found' : 'missing'})`,
    placeHolder: `${status.path}${status.serverRunning ? ' · server running' : ''}`,
  });
  if (!choice) {
    return;
  }

  try {
    if (choice.label.includes('download')) {
      await vscode.env.clipboard.writeText(buildDownloadCommand(services.models.spec));
      void vscode.window.showInformationMessage(
        `Download command copied. Model file: ${status.spec.fileName} (~${Math.round(status.spec.approxBytes / 1e9)} GB, ${status.spec.quantization}).`
      );
    } else if (choice.label.includes('Start')) {
      const port = safePort(settings.local.serverUrl);
      const pid = await services.models.startServer({
        modelPath: settings.local.modelPath,
        port,
        contextTokens: status.spec.contextTokens,
      });
      void vscode.window.showInformationMessage(`llama-server started (pid ${pid}).`);
    } else if (choice.label.includes('Stop')) {
      const stopped = services.models.stopServer();
      void vscode.window.showInformationMessage(
        stopped ? 'llama-server stopped.' : 'No llama-server process was started by this window.'
      );
    } else {
      await vscode.env.openExternal(vscode.Uri.file(status.path));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`AI I/O model action failed: ${message}`);
  }
}

function safePort(serverUrl: string): number {
  try {
    const parsed = new URL(serverUrl);
    return parsed.port ? Number(parsed.port) : 8080;
  } catch {
    return 8080;
  }
}

export function registerCommands(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(ROUTE_PROMPT_COMMAND, () =>
      routePrompt(services)
    ),
    vscode.commands.registerCommand(SHOW_DASHBOARD_COMMAND, () => {
      const panel = showDashboardPanel();
      const ledger = services.metrics.current;
      panel.update(ledger.snapshot(), ledger.allEntries());
    }),
    vscode.commands.registerCommand(MANAGE_MODEL_COMMAND, () =>
      manageModel(services)
    )
  );
}