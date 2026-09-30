/**
 * Configuration adapter: the only place that knows the VS Code settings keys.
 */

import * as vscode from 'vscode';
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
}

export interface ExtensionSettings {
  cloud: CloudSettings;
  local: LocalSettings;
  routing: RoutingSettings;
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