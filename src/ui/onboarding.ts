/**
 * Presentation layer: first-run / reconfiguration flow for the cloud endpoint.
 *
 * `runConfigureFlow` walks the user through picking a provider preset
 * (Ollama, OpenAI, or a custom OpenAI-compatible URL), offers auto-detected
 * model names from `GET /models`, and writes the result to workspace or user
 * settings. It is used by the `aiio.configure` command and offered
 * automatically on first activation.
 */

import * as vscode from 'vscode';
import type { ExtensionSettings } from '../config/settings';
import { readSettings } from '../config/settings';
import { CloudClient } from '../cloud/cloudClient';

export const CONFIGURE_COMMAND = 'aiio.configure';

interface ProviderPreset {
  label: string;
  detail: string;
  baseUrl: string;
  needsKey: boolean;
  defaultModel: string;
}

const PRESETS: ProviderPreset[] = [
  {
    label: 'Ollama（本地，推荐演示）',
    detail: 'http://localhost:11434/v1 — 无需 API key',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    defaultModel: 'qwen3:4b',
  },
  {
    label: 'OpenAI',
    detail: 'https://api.openai.com/v1 — 需要 API key',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    defaultModel: 'gpt-4o-mini',
  },
  {
    label: '自定义 OpenAI 兼容端点',
    detail: 'llama.cpp / LM Studio / 自建网关等',
    baseUrl: '',
    needsKey: false,
    defaultModel: '',
  },
];

function clientFor(baseUrl: string, apiKey: string, model: string): CloudClient {
  return new CloudClient({
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
  });
}

/** True when the current configuration already works (probe /models). */
export async function isCloudReachable(settings: ExtensionSettings): Promise<boolean> {
  const client = clientFor(
    settings.cloud.baseUrl,
    settings.cloud.apiKey,
    settings.cloud.model
  );
  if (!client.isConfigured) {
    return false;
  }
  const result = await client.listModels();
  return result.ok;
}

/**
 * Walk through endpoint + model + key configuration and persist it.
 * Returns true when the flow finished with a verified endpoint.
 */
export async function runConfigureFlow(): Promise<boolean> {
  const current = readSettings();

  if (await isCloudReachable(current)) {
    const keep = '保持现状';
    const change = '重新配置';
    const choice = await vscode.window.showInformationMessage(
      `AI I/O · 云端端点可用（${current.cloud.baseUrl}，模型 ${current.cloud.model}）。要重新配置吗？`,
      keep,
      change
    );
    if (choice !== change) {
      return true;
    }
  } else {
    const start = '开始配置';
    const skip = '跳过';
    const choice = await vscode.window.showInformationMessage(
      'AI I/O · 未检测到可用的云端 AI 端点。配置一个后才能获得回答（本地 llama.cpp 可选，无需也可）。',
      start,
      skip
    );
    if (choice !== start) {
      return false;
    }
  }

  const preset = await pickProvider();
  if (!preset) {
    return false;
  }

  let baseUrl = preset.baseUrl;
  if (baseUrl.length === 0) {
    const input = await vscode.window.showInputBox({
      title: 'AI I/O · 云端端点',
      prompt: 'OpenAI 兼容的 base URL',
      placeHolder: '例如 http://localhost:8080 或 http://localhost:1234/v1',
      ignoreFocusOut: true,
    });
    if (!input || input.trim().length === 0) {
      return false;
    }
    baseUrl = input.trim();
  }

  let apiKey = current.cloud.apiKey;
  if (preset.needsKey && apiKey.length === 0) {
    apiKey = (
      await vscode.window.showInputBox({
        title: 'AI I/O · API key',
        prompt: '粘贴 API key（仅存于 VS Code settings，勿提交版本库）',
        password: true,
        ignoreFocusOut: true,
      })
    ) ?? '';
    if (apiKey.length === 0) {
      void vscode.window.showErrorMessage('AI I/O: 云端配置已取消（未提供 API key）。');
      return false;
    }
  }
  if (!preset.needsKey) {
    apiKey = '';
  }

  const model = await pickModel(baseUrl, apiKey, preset.defaultModel);
  if (!model || model.length === 0) {
    return false;
  }

  const scope = await pickScope();
  if (!scope) {
    return false;
  }
  const config = vscode.workspace.getConfiguration('aiio');
  await Promise.all([
    config.update('cloudBaseUrl', baseUrl, scope),
    config.update('cloudModel', model, scope),
    config.update('cloudApiKey', apiKey, scope),
  ]);

  const probe = await clientFor(baseUrl, apiKey, model).listModels();
  if (probe.ok) {
    const modelList = probe.models.length > 0 ? probe.models.slice(0, 5).join('、') : '（端点未列出模型）';
    void vscode.window.showInformationMessage(
      `AI I/O · 云端已就绪：${baseUrl}（可用模型：${modelList}…）`
    );
    return true;
  }
  void vscode.window.showWarningMessage(
    `AI I/O · 配置已保存，但端点暂不可达（${probe.error}）。可在侧边栏点「测试」重试，或用命令「AI I/O: Configure Cloud」重新配置。`
  );
  return false;
}

async function pickProvider(): Promise<ProviderPreset | undefined> {
  const choice = await vscode.window.showQuickPick(
    PRESETS.map((preset) => ({
      label: preset.label,
      description: preset.detail,
      preset,
    })),
    {
      title: 'AI I/O · 选择云端提供商',
      placeHolder: '所有提供商都走 OpenAI 兼容接口',
    }
  );
  return choice?.preset;
}

/** Offer models advertised by the endpoint, with manual entry as fallback. */
async function pickModel(
  baseUrl: string,
  apiKey: string,
  defaultModel: string
): Promise<string | undefined> {
  const probe = await clientFor(baseUrl, apiKey, defaultModel || 'any').listModels();

  if (probe.ok && probe.models.length > 0) {
    const items = [
      ...probe.models
        .filter((name) => name !== defaultModel)
        .map((name) => ({ label: name, description: '来自端点', model: name })),
      ...(defaultModel && !probe.models.includes(defaultModel)
        ? [{ label: defaultModel, description: '预设', model: defaultModel }]
        : []),
    ];
    const choice = await vscode.window.showQuickPick(items, {
      title: `AI I/O · 选择模型（${baseUrl}）`,
      placeHolder: '点选端点已列出的模型',
    });
    return choice?.model;
  }

  const input = await vscode.window.showInputBox({
    title: 'AI I/O · 模型名',
    prompt: probe.error
      ? `端点当前不可达（${probe.error}），直接输入要使用的模型名`
      : '端点未列出模型，请输入要使用的模型名',
    placeHolder: defaultModel || '例如 qwen3:4b / gpt-4o-mini / llama3.2',
    value: defaultModel,
    ignoreFocusOut: true,
  });
  return input && input.trim().length > 0 ? input.trim() : undefined;
}

async function pickScope(): Promise<vscode.ConfigurationTarget | undefined> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: '仅当前工作区', description: '写入 .vscode/settings.json，不影响其他项目', scope: vscode.ConfigurationTarget.Workspace },
      { label: '所有项目（用户级）', description: '写入用户设置', scope: vscode.ConfigurationTarget.Global },
    ],
    {
      title: 'AI I/O · 配置保存在哪里？',
      placeHolder: 'API key 会随配置写入所选位置',
    }
  );
  return choice?.scope;
}
