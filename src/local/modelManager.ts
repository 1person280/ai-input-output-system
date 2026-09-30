/**
 * Infrastructure layer: locate the GGUF weights and own the llama-server
 * process lifecycle. Deliberately free of the VS Code API so it stays testable
 * and reusable from the CLI script.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';

export interface ModelSpec {
  id: string;
  fileName: string;
  quantization: string;
  contextTokens: number;
  /** Upstream GGUF location; override per mirror in docs/model.md. */
  downloadUrl: string;
  approxBytes: number;
  /** Expected SHA-256, or `skip` to download without enforcing integrity. */
  sha256: string;
}

export const DEFAULT_MODEL: ModelSpec = {
  id: 'qwen3-4b-instruct-q8_0',
  fileName: 'Qwen3-4B-Instruct-Q8_0.gguf',
  quantization: 'Q8_0',
  contextTokens: 65536,
  downloadUrl: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q8_0.gguf',
  approxBytes: 4_280_404_704,
  sha256: 'skip',
};

export interface ServerLaunchOptions {
  modelPath: string;
  host?: string;
  port?: number;
  contextTokens?: number;
  gpuLayers?: number;
  executable?: string;
}

export interface ModelStatus {
  present: boolean;
  path: string;
  spec: ModelSpec;
  serverRunning: boolean;
}

export function defaultModelDirectory(workspaceRoot: string | undefined): string {
  return workspaceRoot ? path.join(workspaceRoot, 'models') : path.join(process.cwd(), 'models');
}

export function buildServerArgs(options: ServerLaunchOptions): string[] {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8080;
  const contextTokens = options.contextTokens ?? DEFAULT_MODEL.contextTokens;
  const gpuLayers = options.gpuLayers ?? 99;
  return [
    '-m',
    options.modelPath,
    '--host',
    host,
    '--port',
    String(port),
    '--ctx-size',
    String(contextTokens),
    '-ngl',
    String(gpuLayers),
  ];
}

export function buildDownloadCommand(spec: ModelSpec = DEFAULT_MODEL): string {
  return `node scripts/download-model.mjs --out models/${spec.fileName}`;
}

export class ModelManager {
  private serverProcess: ChildProcess | undefined;

  constructor(
    private readonly modelDirectory: string,
    readonly spec: ModelSpec = DEFAULT_MODEL
  ) {}

  /** Configured path wins; otherwise fall back to <modelDirectory>/<fileName>. */
  resolveModelPath(configuredPath?: string): string {
    if (configuredPath && configuredPath.trim().length > 0) {
      return path.resolve(configuredPath.trim());
    }
    return path.join(this.modelDirectory, this.spec.fileName);
  }

  async isModelPresent(configuredPath?: string): Promise<boolean> {
    const target = this.resolveModelPath(configuredPath);
    try {
      const info = await stat(target);
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  }

  async inspect(configuredPath?: string): Promise<ModelStatus> {
    const target = this.resolveModelPath(configuredPath);
    return {
      present: await this.isModelPresent(configuredPath),
      path: target,
      spec: this.spec,
      serverRunning: this.isServerRunning,
    };
  }

  get isServerRunning(): boolean {
    return Boolean(this.serverProcess && this.serverProcess.exitCode === null);
  }

  get pid(): number | undefined {
    return this.serverProcess?.pid;
  }

  /**
   * Spawn `llama-server`. Rejects when the model file is missing so callers can
   * surface the download instructions instead of a cryptic crash.
   */
  async startServer(options: ServerLaunchOptions): Promise<number> {
    if (this.isServerRunning) {
      throw new Error('llama-server is already running');
    }
    const modelPath = this.resolveModelPath(options.modelPath);
    if (!(await this.isModelPresent(modelPath))) {
      throw new Error(
        `Model not found at ${modelPath}. Run: ${buildDownloadCommand(this.spec)}`
      );
    }

    const executable = options.executable ?? 'llama-server';
    const args = buildServerArgs({ ...options, modelPath });
    const child = spawn(executable, args, { stdio: 'ignore' });
    this.serverProcess = child;

    return await new Promise<number>((resolve, reject) => {
      child.once('error', (error) => {
        this.serverProcess = undefined;
        reject(
          new Error(
            `Failed to launch "${executable}" (${error.message}). Install llama.cpp and ensure it is on PATH.`
          )
        );
      });
      child.once('spawn', () => {
        if (child.pid === undefined) {
          reject(new Error('llama-server spawned without a pid'));
          return;
        }
        resolve(child.pid);
      });
    });
  }

  stopServer(): boolean {
    if (!this.serverProcess) {
      return false;
    }
    const stopped = this.serverProcess.kill();
    this.serverProcess = undefined;
    return stopped;
  }

  dispose(): void {
    this.stopServer();
  }
}