/**
 * 领域层：把模型返回的文本解析为 FilePlan。
 *
 * 纯函数，不依赖 vscode。模型输出不可控，因此容忍：
 * - 前后夹带的解释性文字；
 * - 整体被 ```json / ``` 代码块包裹；
 * - files 为数组、`{ 路径: 内容 }` 映射，或单个 `{ path, content }` 对象。
 */

import type { FilePlan, PlannedFile, PlanSource } from './filePlan';
import { isSafeRelativePath, normaliseRelativePath } from './filePlan';

/** 从原始文本里收集可能包含 JSON 的候选片段（去重、保序）。 */
function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      candidates.push(trimmed);
    }
  };

  // 1) 直接尝试原文
  push(raw);

  // 2) ```json ... ``` / ``` ... ``` 代码块
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(raw)) !== null) {
    push(match[1]);
  }

  // 3) 第一个 { / [ 到最后一个 } / ] 之间的片段
  const boundaries: ReadonlyArray<[string, string]> = [
    ['{', '}'],
    ['[', ']'],
  ];
  for (const [open, close] of boundaries) {
    const start = raw.indexOf(open);
    const end = raw.lastIndexOf(close);
    if (start !== -1 && end > start) {
      push(raw.slice(start, end + 1));
    }
  }

  return candidates;
}

/** 把内容字段统一成字符串；对象/数组走 JSON 序列化以保持可读。 */
function coerceContent(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return null;
    }
  }
  return String(value);
}

/** 把一个候选条目规整为 PlannedFile；非法则返回 null。 */
function toPlannedFile(entry: unknown): PlannedFile | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const rawPath =
    typeof record.path === 'string'
      ? record.path
      : typeof record.filePath === 'string'
        ? record.filePath
        : null;
  if (!rawPath || !isSafeRelativePath(rawPath)) {
    return null;
  }
  const content = coerceContent(record.content);
  if (content === null) {
    return null;
  }
  return { path: normaliseRelativePath(rawPath), content };
}

/** 从任意 JSON 结构中收集文件条目。 */
function collectEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.files)) {
    return record.files;
  }
  if (record.files && typeof record.files === 'object') {
    return Object.entries(record.files as Record<string, unknown>).map(
      ([path, content]) => ({ path, content })
    );
  }
  if (typeof record.path === 'string') {
    return [record];
  }
  return [];
}

/**
 * 解析模型返回文本，抽出其中的文件计划。
 *
 * @param raw 模型原始输出（可能夹带前言后语或代码块）
 * @param requirement 原始需求，原样写回计划
 * @param source 本次规划来源
 * @returns 合法计划；完全无法解析或校验不通过时返回 null
 */
export function parseModelPlan(
  raw: string,
  requirement: string,
  source: PlanSource
): FilePlan | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }

  for (const candidate of extractJsonCandidates(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    const files: PlannedFile[] = [];
    for (const entry of collectEntries(parsed)) {
      const file = toPlannedFile(entry);
      if (file) {
        files.push(file);
      }
    }
    if (files.length > 0) {
      return { files, source, requirement };
    }
  }

  return null;
}