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
import { ExtensionSettings, onSettingsChanged, readSettings } from './config/settings';
import {
  OLLAMA_BASE_URL,
  isOllamaRunning,
  startLocalBackend,
} from './local/localBackend';
import { LocalModelClient } from './local/localModelClient';
import { LocalHealthMonitor } from './local/localHealthMonitor';
import { defaultModelDirectory, ModelManager } from './local/modelManager';
import { DecisionJournalStore } from './metrics/decisionJournalStore';
import { MetricsStore } from './metrics/metricsStore';
import {
  AdaptiveThreshold,
  computeAdaptiveThreshold,
  DEFAULT_ADAPTATION,
} from './routing/adaptiveThreshold';
import { computeOnlineQuality, OnlineQuality } from './routing/decisionQuality';
import {
  DEFAULT_LOCAL_CONDITION_OPTIONS,
  estimateLocalLatency,
} from './routing/localCondition';
import { Router } from './routing/router';
import { registerCommands } from './ui/commands';
import { AiChatPanelProvider, ChatConnectionStatus, ChatRouterOverride } from './ui/chatPanel';
import { DashboardConnectionStatus, getDashboardPanel } from './ui/dashboardPanel';
import { CONFIGURE_COMMAND, isCloudReachable, runConfigureFlow } from './ui/onboarding';
import { StatusBarController } from './ui/statusBar';

/** 聊天面板用扁平形状、仪表盘用 cloud 嵌套形状；一次探测同时满足两者。 */
type ConnectionProbe = ChatConnectionStatus & DashboardConnectionStatus;

export function activate(context: vscode.ExtensionContext): void {
  let settings = readSettings();

  const metrics = new MetricsStore(context.globalState);
  const journal = new DecisionJournalStore(context.globalState);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const models = new ModelManager(defaultModelDirectory(workspaceRoot));
  const statusBar = new StatusBarController();
  const output = vscode.window.createOutputChannel('AI I/O System');
  // 健康监视器随 serverUrl 变化而重建；其余地方只读取它的缓存快照。
  let health = createHealthMonitor(settings.local.serverUrl);

  const computeAdaptive = (): AdaptiveThreshold =>
    computeAdaptiveThreshold(
      journal.current.records(),
      journal.current.allFeedback(),
      {
        baseThreshold: settings.routing.threshold,
        enabled: settings.routing.adaptiveRouting,
        ...DEFAULT_ADAPTATION,
      }
    );

  const getRouter = (override?: ChatRouterOverride): Router => {
    // 会话级覆盖仅影响聊天面板的请求：cloud 模式强制走云端，model 换默认模型。
    const forceCloud = override?.routeMode === 'cloud';
    const model = override?.model ?? settings.cloud.model;
    return new Router({
      cloud: new CloudClient({
        baseUrl: settings.cloud.baseUrl,
        apiKey: settings.cloud.apiKey,
        model,
      }),
      local:
        settings.routing.enableLocalRouting && !forceCloud
          ? new LocalModelClient({ serverUrl: settings.local.serverUrl })
          : null,
      ledger: metrics,
      journal,
      options: {
        threshold: computeAdaptive().effective,
        enableLocalRouting: settings.routing.enableLocalRouting && !forceCloud,
        fallbackToCloud: true,
        weights: settings.routing.weights,
        localCondition: () => ({
          available: health.snapshot(),
          ...estimateLocalLatency(journal.current.records()),
        }),
        localConditionOptions: {
          ...DEFAULT_LOCAL_CONDITION_OPTIONS,
          enabled: settings.routing.localHealthAware,
        },
        ensureLocalHealth: async (): Promise<void> => {
          if (health.isStale()) {
            await health.refresh();
          }
        },
      },
    });
  };

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
    getDashboardPanel()?.update(
      snapshot,
      ledger.allEntries(),
      getRoutingQuality(),
      computeAdaptive()
    );
  };

  const testConnections = async (): Promise<ConnectionProbe> => {
    // Ollama 常见安装在 11434；若设置仍是 llama-server 默认 8080 且本地不可达，
    // 自动探测 Ollama 并改写设置，避免"本地不可达"的假阴性。
    const healthProbe = await new LocalModelClient({
      serverUrl: settings.local.serverUrl,
    }).isAvailable();
    if (
      !healthProbe &&
      settings.local.serverUrl !== OLLAMA_BASE_URL &&
      (await isOllamaRunning())
    ) {
      await vscode.workspace
        .getConfiguration('aiio')
        .update('localServerUrl', OLLAMA_BASE_URL, vscode.ConfigurationTarget.Global);
      settings = readSettings();
      health = createHealthMonitor(settings.local.serverUrl);
    }
    const cloudClient = new CloudClient({
      baseUrl: settings.cloud.baseUrl,
      apiKey: settings.cloud.apiKey,
      model: settings.cloud.model,
    });
    const probe = await cloudClient.listModels();
    const localAvailable = await new LocalModelClient({
      serverUrl: settings.local.serverUrl,
    }).isAvailable();
    return {
      ok: probe.ok,
      error: probe.error,
      models: probe.models,
      keyless: cloudClient.isKeylessEndpoint,
      hasKey: settings.cloud.apiKey.length > 0,
      endpoint: settings.cloud.baseUrl,
      model: settings.cloud.model,
      cloud: {
        ok: probe.ok,
        error: probe.error,
        models: probe.models,
        endpoint: settings.cloud.baseUrl,
        model: settings.cloud.model,
      },
      local: {
        available: localAvailable,
        endpoint: settings.local.serverUrl,
      },
    };
  };

  // 侧边栏 AI 助手：与命令共用同一路由管线。
  const chatPanel = new AiChatPanelProvider({
    getRouter,
    getSettings: (): ExtensionSettings => settings,
    testCloudConnection: testConnections,
    refreshViews,
    startLocalBackend: async () => {
      const result = await startLocalBackend();
      if (result.ok && result.baseUrl) {
        // 把本地端点指向刚启动/接管的服务，让路由立即生效。
        if (settings.local.serverUrl !== result.baseUrl) {
          await vscode.workspace
            .getConfiguration('aiio')
            .update('localServerUrl', result.baseUrl, vscode.ConfigurationTarget.Global);
          settings = readSettings();
          health = createHealthMonitor(settings.local.serverUrl);
        }
        await health.refresh();
      }
      if (result.needsInstall) {
        const install = '打开下载页';
        const choice = await vscode.window.showInformationMessage(
          'AI I/O · 未检测到 Ollama。安装后即可在本地回答简单请求（免费、离线）。',
          install
        );
        if (choice === install) {
          await vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
        }
      }
      return { ok: result.ok, needsInstall: result.needsInstall, message: result.message };
    },
  });

  registerCommands(context, {
    metrics,
    models,
    getSettings: (): ExtensionSettings => settings,
    getRouter,
    getAutonomousCreator,
    recordFeedback: async (requestId, verdict) => {
      await journal.recordFeedback({ requestId, verdict, signal: 'explicit' });
    },
    getRoutingQuality,
    getAdaptiveThreshold: computeAdaptive,
    refreshLocalHealth: async () => {
      await health.refresh();
    },
    resetMetrics: async () => {
      await metrics.reset();
      refreshViews();
    },
    testConnections,
    refreshViews,
  });

  context.subscriptions.push(
    statusBar,
    models,
    output,
    vscode.window.registerWebviewViewProvider('aiio.chat', chatPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand(CONFIGURE_COMMAND, () => runConfigureFlow()),
    onSettingsChanged(async (next) => {
      settings = next;
      // serverUrl 可能变化，按新配置重建健康监视器。
      health = createHealthMonitor(settings.local.serverUrl);
      refreshViews();
    })
  );

  refreshViews();

  // 启动时自动检测 Ollama：若配置的 localServerUrl 不可达且 Ollama 在运行，
  // 自动改写为 Ollama 端口，让本地路由立即生效。
  void (async () => {
    const localClient = new LocalModelClient({ serverUrl: settings.local.serverUrl });
    if (await localClient.isAvailable()) {
      return; // 当前配置已可用，无需切换。
    }
    if (settings.local.serverUrl === OLLAMA_BASE_URL) {
      return; // 已经是 Ollama 地址但不可达，说明 Ollama 确实没在跑。
    }
    if (await isOllamaRunning()) {
      await vscode.workspace
        .getConfiguration('aiio')
        .update('localServerUrl', OLLAMA_BASE_URL, vscode.ConfigurationTarget.Global);
      settings = readSettings();
      health = createHealthMonitor(settings.local.serverUrl);
    }
  })();

  // 首次激活引导：云端端点不可用时只提示一次，不打断启动。
  void offerFirstRunOnboarding(context);

  if (settings.autonomous.onStartup && settings.autonomous.requirement.trim().length > 0) {
    void runStartupCreation(
      getAutonomousCreator,
      settings.autonomous.requirement.trim()
    );
  }
}

/** 首次激活：云端不可达且用户尚未拒绝过引导时，提议配置流程。 */
async function offerFirstRunOnboarding(context: vscode.ExtensionContext): Promise<void> {
  const SKIPPED_KEY = 'aiio.onboarding.skipped';
  if (context.globalState.get<boolean>(SKIPPED_KEY) === true) {
    return;
  }
  const settings = readSettings();
  if (await isCloudReachable(settings)) {
    return;
  }
  const configure = '配置云端';
  const skip = '暂不';
  const choice = await vscode.window.showInformationMessage(
    'AI I/O · 欢迎使用！尚未检测到可用的云端 AI 端点（Ollama / OpenAI 等均可）。现在配置一个吗？',
    configure,
    skip
  );
  if (choice === configure) {
    await runConfigureFlow();
  } else if (choice === skip) {
    await context.globalState.update(SKIPPED_KEY, true);
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

function createHealthMonitor(serverUrl: string): LocalHealthMonitor {
  return new LocalHealthMonitor(new LocalModelClient({ serverUrl }));
}

export function deactivate(): void {
  // Children and disposables are released through context.subscriptions.
}