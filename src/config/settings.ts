/**
 * Configuration adapter: the only place that knows the VS Code settings keys.
 */

import * as vscode from 'vscode';
import {
  ClassifierWeights,
  normaliseWeights,
} from '../routing/classifierWeights';
import { DEFAULT_ROUTING_THRESHOLD, normaliseThreshold } from '../routing/routingPolicy';

export interface CloudSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LocalSettings {
  serverUrl: string;
  modelPath: string;
}

export interface RoutingSettings {
  threshold: number;
  enableLocalRouting: boolean;
  /** 本地模型是否可以向云端专家求助（[ESCALATE] 协议）。 */
  escalationEnabled: boolean;
  /** Ask for a thumbs-up/down after a local answer to feed decision quality. */
  collectFeedback: boolean;
  /** 是否让本地服务可用性 / 延迟参与路由决策。 */
  localHealthAware: boolean;
  /** Tuned classifier coefficients; defaults are used when unset. */
  weights: ClassifierWeights;
}

export interface AutonomousSettings {
  /** 激活时是否自动依据 autonomousRequirement 创建文件。 */
  onStartup: boolean;
  /** 启动时使用的自然语言需求；为空则不触发。 */
  requirement: string;
  /** 相对工作区根的子目录，所有生成文件落在这里。 */
  targetSubdirectory: string;
}

export interface ExtensionSettings {
  cloud: CloudSettings;
  local: LocalSettings;
  routing: RoutingSettings;
  autonomous: AutonomousSettings;
}

const SECTION = 'aiio';

function read<T>(key: string, fallback: T): T {
  const value = vscode.workspace.getConfiguration(SECTION).get<T>(key);
  return value === undefined || value === null ? fallback : value;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function readSettings(): ExtensionSettings {
  return {
    cloud: {
      baseUrl: trimTrailingSlash(
        read('cloudBaseUrl', 'https://api.openai.com/v1')
      ),
      apiKey: read('cloudApiKey', ''),
      model: read('cloudModel', 'gpt-4o-mini'),
    },
    local: {
      serverUrl: trimTrailingSlash(
        read('localServerUrl', 'http://127.0.0.1:8080')
      ),
      modelPath: read('localModelPath', ''),
    },
    routing: {
      threshold: normaliseThreshold(
        read('routingThreshold', DEFAULT_ROUTING_THRESHOLD)
      ),
      enableLocalRouting: read('enableLocalRouting', true),
      escalationEnabled: read('escalationEnabled', true),
      collectFeedback: read('collectRoutingFeedback', true),
      localHealthAware: read('localHealthAware', true),
      weights: normaliseWeights(read('classifierWeights', {})),
    },
    autonomous: {
      onStartup: read('autonomousOnStartup', false),
      requirement: read('autonomousRequirement', ''),
      targetSubdirectory: read('targetSubdirectory', 'aiio-generated'),
    },
  };
}

export function onSettingsChanged(
  listener: (settings: ExtensionSettings) => void
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SECTION)) {
      listener(readSettings());
    }
  });
}