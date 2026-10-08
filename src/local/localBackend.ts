/**
 * Infrastructure layer: one-click local backend bootstrap.
 *
 * The user may not run llama.cpp at all — Ollama is the far more common local
 * OpenAI-compatible server. This module detects whether Ollama is installed
 * (well-known Windows/macOS/Linux locations plus PATH), whether it is already
 * serving, starts it when needed, and reports the endpoint the extension
 * should route local traffic to. Installation guidance is returned as text so
 * the presentation layer can render buttons.
 */

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

export const OLLAMA_DEFAULT_PORT = 11434;
export const OLLAMA_BASE_URL = `http://127.0.0.1:${OLLAMA_DEFAULT_PORT}`;

export interface LocalBackendStatus {
  /** Ollama executable found on this machine. */
  installed: boolean;
  /** Path of the executable when found. */
  executablePath?: string;
  /** Ollama is currently serving its OpenAI-compatible API. */
  running: boolean;
  /** Base URL local requests should use (Ollama when available). */
  baseUrl?: string;
  /** Actionable message for the user, already localised to zh-CN. */
  message: string;
}

export interface StartBackendResult {
  ok: boolean;
  /** Endpoint to write into `aiio.localServerUrl` on success. */
  baseUrl?: string;
  /** True when the backend was started by this call (vs already running). */
  startedHere: boolean;
  /** True when Ollama is not installed at all. */
  needsInstall: boolean;
  message: string;
}

/** Well-known Ollama install locations, checked in order. */
function candidateExecutables(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [
      path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe'),
      path.join(localAppData, 'Ollama', 'ollama.exe'),
      'C:\\Program Files\\Ollama\\ollama.exe',
    ];
  }
  if (process.platform === 'darwin') {
    return ['/Applications/Ollama.app/Contents/Resources/ollama', '/usr/local/bin/ollama'];
  }
  return ['/usr/bin/ollama', '/usr/local/bin/ollama', path.join(home, '.local', 'bin', 'ollama')];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate the Ollama executable; '' when not installed. */
export async function findOllamaExecutable(): Promise<string> {
  for (const candidate of candidateExecutables()) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return '';
}

/** Probe the OpenAI-compatible endpoint to decide "running". */
export async function isOllamaRunning(
  baseUrl: string = OLLAMA_BASE_URL
): Promise<boolean> {
  // Ollama serves /v1/models even with zero models pulled; /health may 404 on
  // older builds, so probe the models list with a short timeout instead.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const response = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

/** Snapshot of the local backend for UI display. */
export async function inspectLocalBackend(): Promise<LocalBackendStatus> {
  const executablePath = await findOllamaExecutable();
  const running = await isOllamaRunning();
  if (running) {
    return {
      installed: true,
      executablePath: executablePath || undefined,
      running: true,
      baseUrl: OLLAMA_BASE_URL,
      message: `Ollama 正在运行（${OLLAMA_BASE_URL}）。`,
    };
  }
  if (executablePath) {
    return {
      installed: true,
      executablePath,
      running: false,
      message: '已安装 Ollama 但服务未运行，可一键启动。',
    };
  }
  return {
    installed: false,
    running: false,
    message: '未检测到本地模型服务（Ollama）。可引导安装，或仅使用云端。',
  };
}

/**
 * Ensure a local backend is serving: reuse a running Ollama, start the
 * installed-but-idle one, or report that installation is needed.
 */
export async function startLocalBackend(): Promise<StartBackendResult> {
  if (await isOllamaRunning()) {
    return {
      ok: true,
      baseUrl: OLLAMA_BASE_URL,
      startedHere: false,
      needsInstall: false,
      message: `本地模型服务已在运行（${OLLAMA_BASE_URL}）。`,
    };
  }

  const executablePath = await findOllamaExecutable();
  if (!executablePath) {
    return {
      ok: false,
      startedHere: false,
      needsInstall: true,
      message:
        '未安装 Ollama。请到 https://ollama.com/download 下载安装，' +
        '或运行：winget install Ollama.Ollama',
    };
  }

  // `ollama serve` blocks, so detach it; the desktop app also listens on the
  // same port, so a "port already in use" failure usually means it is up.
  const child = spawn(executablePath, ['serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  // Poll for readiness — model server startup takes a moment.
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (await isOllamaRunning()) {
      return {
        ok: true,
        baseUrl: OLLAMA_BASE_URL,
        startedHere: true,
        needsInstall: false,
        message: `Ollama 已启动（${OLLAMA_BASE_URL}）。`,
      };
    }
    if (child.exitCode !== null && child.exitCode !== 0) {
      // Serve failed — often because the tray app already holds the port.
      if (await isOllamaRunning()) {
        return {
          ok: true,
          baseUrl: OLLAMA_BASE_URL,
          startedHere: false,
          needsInstall: false,
          message: `本地模型服务已在运行（${OLLAMA_BASE_URL}）。`,
        };
      }
      break;
    }
  }

  return {
    ok: false,
    startedHere: true,
    needsInstall: false,
    message: '已尝试启动 Ollama，但端口暂未就绪；若桌面版正在初始化请稍后再试。',
  };
}
