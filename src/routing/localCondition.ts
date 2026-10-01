/**
 * 领域层：本地服务状况对路由的门控（纯函数）。
 *
 * 基础策略只看复杂度；本模块在此基础上叠加「本地是否可用」与「近期本地延迟是否
 * 超预算」两个信号。二者都只可能把一次本已判为 local 的决策改成 cloud，永远不会
 * 反过来，因此不改变基础策略的单向收敛性质。
 *
 * 延迟来源于 {@link DecisionRecord.latencyMs}，即历史路由记录，不需要额外存储。
 */

import type { DecisionRecord } from './decisionJournal';
import type { RouteDecision } from './routingPolicy';

export interface LocalCondition {
  /** 本地 llama-server 是否可用（来自带 TTL 的健康探测缓存）。 */
  available: boolean;
  /** 近期本地回答的平均延迟（毫秒）；null 表示样本不足。 */
  observedLatencyMs: number | null;
  latencySamples: number;
}

export interface LocalConditionOptions {
  enabled: boolean;
  /** 超过该延迟预算的本地候选改走云端。 */
  latencyBudgetMs: number;
  /** 延迟样本低于该值时忽略延迟信号。 */
  minLatencySamples: number;
}

export const DEFAULT_LOCAL_CONDITION_OPTIONS: LocalConditionOptions = {
  enabled: true,
  latencyBudgetMs: 4000,
  minLatencySamples: 5,
};

/** 估计延迟时只回看最近的 N 条本地记录。 */
const LATENCY_WINDOW = 50;

/**
 * 从历史记录估计近期本地平均延迟。样本不足时返回 null，调用方据此跳过延迟门控。
 */
export function estimateLocalLatency(
  records: ReadonlyArray<DecisionRecord>,
  windowSize: number = LATENCY_WINDOW
): { observedLatencyMs: number | null; latencySamples: number } {
  let sum = 0;
  let samples = 0;
  // 记录按时间顺序追加，从尾部倒着取即「最近优先」。
  for (let index = records.length - 1; index >= 0 && samples < windowSize; index -= 1) {
    const record = records[index];
    if (record.actualRoute !== 'local' || record.latencyMs <= 0) {
      continue;
    }
    sum += record.latencyMs;
    samples += 1;
  }
  return samples === 0
    ? { observedLatencyMs: null, latencySamples: 0 }
    : { observedLatencyMs: sum / samples, latencySamples: samples };
}

/**
 * 把本地状况叠加到基础决策上。关闭、或基础决策本就是 cloud 时原样返回。
 */
export function applyLocalCondition(
  base: RouteDecision,
  condition: LocalCondition,
  options: LocalConditionOptions
): RouteDecision {
  if (!options.enabled || base.route !== 'local') {
    return base;
  }

  if (!condition.available) {
    return {
      ...base,
      route: 'cloud',
      reason: 'Local server unavailable, answering in the cloud',
    };
  }

  const latency = condition.observedLatencyMs;
  if (
    latency !== null &&
    condition.latencySamples >= options.minLatencySamples &&
    latency > options.latencyBudgetMs
  ) {
    return {
      ...base,
      route: 'cloud',
      reason: `Recent local latency ${Math.round(latency)} ms exceeds the ${options.latencyBudgetMs} ms budget`,
    };
  }

  return base;
}