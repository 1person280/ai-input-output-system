/**
 * 应用层：自主创建文件编排器（本地模型 → 云端模型 → 离线启发式三级降级）。
 *
 * 这是 agent 层里唯一接触 vscode 与网络客户端的模块：负责组织模型调用、
 * 解析出文件计划，并真正把内容写进工作区。纯逻辑全部下沉到 planParser /
 * heuristicPlanner，便于单测。
 */

import * as vscode from 'vscode';
import type { ChatMessage, CloudClient } from '../cloud/cloudClient';
import type { LocalModelClient } from '../local/localModelClient';
import type { FilePlan } from './filePlan';
import { planFromRequirement } from './heuristicPlanner';
import { parseModelPlan } from './planParser';

export interface AutonomousCreatorDeps {
  /** 本地模型客户端；为 null 表示本轮不尝试本地。 */
  local: LocalModelClient | null;
  cloud: CloudClient;
  /** 输出通道，用于外部核验整个「解码 → 规划 → 落盘」流程。 */
  output: vscode.OutputChannel;
  /** 相对工作区根的目标子目录，所有生成文件都落在这里。 */
  targetSubdirectory: string;
  /** 工作区根目录；未打开工作区时为 undefined。 */
  workspaceRoot: vscode.Uri | undefined;
}

const OUTPUT_PREFIX = '[aiio/agent]';

/** 给模型的结构化提示：只返回可解析的 JSON 文件计划。 */
function buildPlanMessages(requirement: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是「AI I/O System」的文件生成器。请只输出一个 JSON 对象，' +
        '形如 {"files":[{"path":"相对路径","content":"文件内容"}]}，' +
        'path 必须是相对工作区的路径，不要输出任何多余解释或 Markdown 代码块。',
    },
    {
      role: 'user',
      content: `需求：${requirement}\n请据此给出需要创建的文件。`,
    },
  ];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AutonomousCreator {
  constructor(private readonly deps: AutonomousCreatorDeps) {}

  /** 依据需求自主创建文件，返回最终使用的计划。 */
  async createFilesFromRequirement(requirement: string): Promise<FilePlan> {
    const trimmed = (requirement ?? '').trim();
    this.log(`收到需求：${trimmed}`);

    const plan = await this.resolvePlan(trimmed);
    this.log(`规划完成：来源=${plan.source}，文件数=${plan.files.length}`);

    await this.writePlan(plan);
    this.log('落盘完成。');
    return plan;
  }

  /** 三级降级：本地 → 云端 → 离线启发式。 */
  private async resolvePlan(requirement: string): Promise<FilePlan> {
    const messages = buildPlanMessages(requirement);

    const fromLocal = await this.tryLocal(messages, requirement);
    if (fromLocal) {
      return fromLocal;
    }

    const fromCloud = await this.tryCloud(messages, requirement);
    if (fromCloud) {
      return fromCloud;
    }

    this.log('本地与云端均不可用，启用离线启发式规划。');
    return planFromRequirement(requirement);
  }

  private async tryLocal(
    messages: ChatMessage[],
    requirement: string
  ): Promise<FilePlan | null> {
    if (!this.deps.local) {
      this.log('本地模型客户端未配置，跳过本地规划。');
      return null;
    }
    if (!(await this.deps.local.isAvailable())) {
      this.log('本地 llama-server 不可达，跳过本地规划。');
      return null;
    }
    try {
      const completion = await this.deps.local.complete(messages, 'chat-completions');
      const plan = parseModelPlan(completion.text, requirement, 'local');
      this.log(
        plan
          ? `本地模型返回可用计划（模型：${completion.model}）。`
          : '本地模型输出无法解析为文件计划。'
      );
      return plan;
    } catch (error) {
      this.log(`本地模型调用失败：${describeError(error)}`);
      return null;
    }
  }

  private async tryCloud(
    messages: ChatMessage[],
    requirement: string
  ): Promise<FilePlan | null> {
    if (!this.deps.cloud.isConfigured) {
      this.log('云端未配置，跳过云端规划。');
      return null;
    }
    try {
      const completion = await this.deps.cloud.complete(messages);
      const plan = parseModelPlan(completion.text, requirement, 'cloud');
      this.log(
        plan
          ? `云端模型返回可用计划（模型：${completion.model}）。`
          : '云端模型输出无法解析为文件计划。'
      );
      return plan;
    } catch (error) {
      this.log(`云端模型调用失败：${describeError(error)}`);
      return null;
    }
  }

  /** 把计划写进「工作区根 / 目标子目录」，自动创建父目录。 */
  private async writePlan(plan: FilePlan): Promise<void> {
    const root = this.deps.workspaceRoot;
    if (!root) {
      throw new Error('未打开工作区，无法写入文件。');
    }

    for (const file of plan.files) {
      const segments = file.path.split('/').filter((segment) => segment.length > 0);
      const directory = vscode.Uri.joinPath(
        root,
        this.deps.targetSubdirectory,
        ...segments.slice(0, -1)
      );
      const uri = vscode.Uri.joinPath(directory, segments[segments.length - 1]);

      await vscode.workspace.fs.createDirectory(directory);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(file.content, 'utf8'));
      this.log(`已写入：${vscode.workspace.asRelativePath(uri)}`);
    }
  }

  private log(message: string): void {
    this.deps.output.appendLine(`${OUTPUT_PREFIX} ${message}`);
  }
}