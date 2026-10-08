/**
 * Presentation layer: command registration and user-facing flows.
 */

import * as vscode from 'vscode';
import type { AutonomousCreator } from '../agent/autonomousCreator';
import { ExtensionSettings } from '../config/settings';
import { buildDownloadCommand, ModelManager } from '../local/modelManager';
import { MetricsStore } from '../metrics/metricsStore';
import type { FeedbackVerdict } from '../routing/decisionJournal';
import type { AdaptiveThreshold } from '../routing/adaptiveThreshold';
import type { OnlineQuality } from '../routing/decisionQuality';
import type { EditorContext } from '../routing/requestClassifier';
import { Router } from '../routing/router';
import { ActionKind, ACTION_PROMPTS } from './chatPanel';
import { DashboardConnectionStatus, showDashboardPanel } from './dashboardPanel';
import { runConfigureFlow } from './onboarding';
import { SHOW_DASHBOARD_COMMAND } from './statusBar';

export const ROUTE_PROMPT_COMMAND = 'aiio.routePrompt';
export const MANAGE_MODEL_COMMAND = 'aiio.manageModel';
export const CREATE_FROM_REQUIREMENT_COMMAND = 'aiio.createFromRequirement';
export const EXPLAIN_SELECTION_COMMAND = 'aiio.explainSelection';
export const COMMENT_SELECTION_COMMAND = 'aiio.commentSelection';
export const REFACTOR_SELECTION_COMMAND = 'aiio.refactorSelection';
export { SHOW_DASHBOARD_COMMAND };

export interface CommandServices {
  metrics: MetricsStore;
  models: ModelManager;
  getSettings(): ExtensionSettings;
  getRouter(): Router;
  /** 按当前配置组装自主创建文件的编排器。 */
  getAutonomousCreator(): AutonomousCreator;
  /** 记录一次路由决定的人工反馈，用于决策质量校准。 */
  recordFeedback(requestId: string, verdict: FeedbackVerdict): void | Promise<void>;
  /** 当前的路由决策质量（在线指标），供仪表盘展示。 */
  getRoutingQuality(): OnlineQuality;
  /** 当前的有效阈值（基准 + 自适应下调），供仪表盘展示。 */
  getAdaptiveThreshold(): AdaptiveThreshold;
  /** 立即重新探测本地服务健康状况（启停模型后调用）。 */
  refreshLocalHealth(): Promise<void>;
  /** 清空路由统计（仪表盘「重置统计」按钮）。 */
  resetMetrics(): void | Promise<void>;
  /** 探测云端端点与本地 llama-server 的可用性（仪表盘「测试连接」）。 */
  testConnections(): Promise<DashboardConnectionStatus>;
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

    if (services.getSettings().routing.collectFeedback && outcome.route === 'local') {
      await collectFeedback(services, outcome.requestId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`AI I/O routing failed: ${message}`);
  }
}

/**
 * Ask the user whether a locally answered prompt was good enough. Only local
 * answers are worth asking about: a cloud answer was already paid for, and this
 * signal is what calibrates the local routing threshold.
 */
async function collectFeedback(
  services: CommandServices,
  requestId: string
): Promise<void> {
  const good = '够用';
  const bad = '不满意';
  const choice = await vscode.window.showInformationMessage(
    'AI I/O · 这次本地回答够用吗？反馈会用于校准路由阈值。',
    good,
    bad
  );
  if (choice === good || choice === bad) {
    await services.recordFeedback(requestId, choice === good ? 'good' : 'bad');
    services.refreshViews();
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
      await services.refreshLocalHealth();
      services.refreshViews();
      void vscode.window.showInformationMessage(`llama-server started (pid ${pid}).`);
    } else if (choice.label.includes('Stop')) {
      const stopped = services.models.stopServer();
      await services.refreshLocalHealth();
      services.refreshViews();
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

async function createFromRequirement(services: CommandServices): Promise<void> {
  const settings = services.getSettings();
  const requirement = await vscode.window.showInputBox({
    title: 'AI I/O · 依据需求自主创建文件',
    prompt: '用自然语言描述你需要的文件，扩展会自行解码并写入工作区。',
    placeHolder: '例如：创建一个 python 脚本读取 csv 并输出摘要',
    value: settings.autonomous.requirement,
    ignoreFocusOut: true,
  });
  if (!requirement || requirement.trim().length === 0) {
    return;
  }

  try {
    const plan = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'AI I/O · 正在解码需求并生成文件…',
      },
      () => services.getAutonomousCreator().createFilesFromRequirement(requirement.trim())
    );

    const names = plan.files.map((file) => file.path).join('、');
    const openLabel = '打开文件';
    const choice = await vscode.window.showInformationMessage(
      `已创建 ${plan.files.length} 个文件（来源：${plan.source}）：${names}`,
      openLabel
    );
    if (choice === openLabel && plan.files.length > 0) {
      await openCreatedFile(services, plan.files[0].path);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`AI I/O 自主创建文件失败：${message}`);
  }
}

/**
 * Editor context menu flow: run a selection-scoped action (解释/注释/重构)
 * through the same router pipeline, then show the answer with its routing
 * metadata. Falls back to a warning when nothing is selected.
 */
async function runSelectionAction(
  services: CommandServices,
  action: ActionKind
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const context = collectEditorContext(editor);
  if (!context.selectedText) {
    void vscode.window.showWarningMessage(
      'AI I/O: 请先在编辑器中选中一段代码。'
    );
    return;
  }
  const prompt = ACTION_PROMPTS[action];
  const router = services.getRouter();
  const preview = router.preview(prompt, context);

  try {
    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `AI I/O · ${action} 选区（${preview.decision.route} 模型）…`,
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
      `# AI I/O · ${action}`,
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
    void vscode.window.showErrorMessage(`AI I/O selection action failed: ${message}`);
  }
}

/** 打开刚生成的文件（拼接工作区根 + 目标子目录）。 */
async function openCreatedFile(
  services: CommandServices,
  relativePath: string
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    return;
  }
  const segments = relativePath.split('/').filter((segment) => segment.length > 0);
  const uri = vscode.Uri.joinPath(
    root,
    services.getSettings().autonomous.targetSubdirectory,
    ...segments
  );
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: true });
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
      const panel = showDashboardPanel({
        resetMetrics: () => services.resetMetrics(),
        testConnections: () => services.testConnections(),
        configure: async () => {
          await runConfigureFlow();
        },
      });
      const ledger = services.metrics.current;
      panel.update(
        ledger.snapshot(),
        ledger.allEntries(),
        services.getRoutingQuality(),
        services.getAdaptiveThreshold()
      );
    }),
    vscode.commands.registerCommand(MANAGE_MODEL_COMMAND, () =>
      manageModel(services)
    ),
    vscode.commands.registerCommand(CREATE_FROM_REQUIREMENT_COMMAND, () =>
      createFromRequirement(services)
    ),
    vscode.commands.registerCommand(EXPLAIN_SELECTION_COMMAND, () =>
      runSelectionAction(services, 'explain')
    ),
    vscode.commands.registerCommand(COMMENT_SELECTION_COMMAND, () =>
      runSelectionAction(services, 'comment')
    ),
    vscode.commands.registerCommand(REFACTOR_SELECTION_COMMAND, () =>
      runSelectionAction(services, 'refactor')
    )
  );
}