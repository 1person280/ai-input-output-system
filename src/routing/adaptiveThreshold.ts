/**
 * 领域层：由在线反馈派生的自适应阈值（纯函数）。
 *
 * 在线唯一可观测的错误是 false-local —— 用户否掉一次本地回答。一次云端回答是否
 * 本可本地完成属于反事实，无法在线观测。因此自适应只单向收紧：当窗口内本地拒否率
 * 超过容忍度时下调有效阈值（把更多请求推向云端），并随反馈转好缓慢回撤到基准，
 * 绝不自动高于用户设定的基准。
 */

import type { DecisionFeedback, DecisionRecord } from './decisionJournal';
import { normaliseThreshold } from './routingPolicy';

export interface AdaptationOptions {
  /** 用户设定的基准阈值，自适应只会在其之下调整。 */
  baseThreshold: number;
  /** 总开关；关闭时有效阈值恒等于基准。 */
  enabled: boolean;
  /** 本地反馈样本低于该值时不做任何调整。 */
  minFeedback: number;
  /** 只统计最近 N 条「本地已作答且有反馈」的记录，使自适应可以回撤。 */
  windowSize: number;
  /** 相对基准的最大降幅。 */
  maxAdjustment: number;
  /** 可容忍的本地拒否率。 */
  tolerance: number;
  /** 拒否率每超出 tolerance 一单位对应的降幅。 */
  sensitivity: number;
}

/** 自适应默认参数；数值以「样本够多之前不动手」为原则。 */
export const DEFAULT_ADAPTATION = {
  minFeedback: 8,
  windowSize: 50,
  maxAdjustment: 0.15,
  tolerance: 0.05,
  sensitivity: 1.5,
} as const;

export interface AdaptiveThreshold {
  base: number;
  effective: number;
  /** base - effective，恒为非负。 */
  adjustment: number;
  /** 窗口内参与统计的本地反馈样本数。 */
  samples: number;
  /** 是否真的产生了下调。 */
  applied: boolean;
  reason: string;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 统计最近 windowSize 条「本地已作答且有反馈」记录中的拒否数。 */
function recentLocalFeedback(
  records: ReadonlyArray<DecisionRecord>,
  feedback: ReadonlyArray<DecisionFeedback>,
  windowSize: number
): { considered: number; rejected: number } {
  const verdictById = new Map<string, DecisionFeedback['verdict']>();
  for (const entry of feedback) {
    verdictById.set(entry.requestId, entry.verdict);
  }

  let considered = 0;
  let rejected = 0;
  // 记录按时间顺序追加，因此从尾部倒着取即「最近优先」。
  for (let index = records.length - 1; index >= 0 && considered < windowSize; index -= 1) {
    const record = records[index];
    if (record.actualRoute !== 'local') {
      continue;
    }
    const verdict = verdictById.get(record.requestId);
    if (!verdict) {
      continue;
    }
    considered += 1;
    if (verdict === 'bad') {
      rejected += 1;
    }
  }
  return { considered, rejected };
}

/**
 * 由反馈历史计算有效阈值。纯函数：相同输入必然得到相同结果，便于离线复现与单测。
 */
export function computeAdaptiveThreshold(
  records: ReadonlyArray<DecisionRecord>,
  feedback: ReadonlyArray<DecisionFeedback>,
  options: AdaptationOptions
): AdaptiveThreshold {
  const base = normaliseThreshold(options.baseThreshold);
  if (!options.enabled) {
    return {
      base,
      effective: base,
      adjustment: 0,
      samples: 0,
      applied: false,
      reason: 'Adaptive routing disabled',
    };
  }

  const { considered, rejected } = recentLocalFeedback(
    records,
    feedback,
    Math.max(1, options.windowSize)
  );
  if (considered < options.minFeedback) {
    return {
      base,
      effective: base,
      adjustment: 0,
      samples: considered,
      applied: false,
      reason: `Not enough local feedback yet (${considered}/${options.minFeedback})`,
    };
  }

  const failureRate = rejected / considered;
  const excess = Math.max(0, failureRate - options.tolerance);
  const adjustment = Math.min(options.maxAdjustment, excess * options.sensitivity);
  const effective = clamp01(base - adjustment);
  const applied = effective < base;

  return {
    base,
    effective,
    adjustment,
    samples: considered,
    applied,
    reason: applied
      ? `Lowered ${base.toFixed(2)} -> ${effective.toFixed(2)} after ${rejected}/${considered} rejected local answers`
      : `Within tolerance (${rejected}/${considered} rejected local answers)`,
  };
}