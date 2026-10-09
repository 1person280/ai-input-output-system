/**
 * 理论 benchmark（离线，不调用任何模型）：在标注语料上评估本地/云端路由分类器。
 *
 * 运行：node scripts/theoreticalBenchmark.cjs
 * （先 npx esbuild scripts/theoreticalBenchmark.ts --bundle --platform=node --format=cjs --outfile=scripts/theoreticalBenchmark.cjs 打包）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateCorpus, DEFAULT_COST_MODEL } from '../src/routing/decisionQuality';
import { validateCorpus } from '../src/routing/labeledCorpus';
import { DEFAULT_ROUTING_THRESHOLD } from '../src/routing/routingPolicy';
import { DEFAULT_CLASSIFIER_WEIGHTS } from '../src/routing/classifierWeights';

const CORPUS_PATH = join(process.cwd(), 'src', 'routing', 'corpus', 'routingCorpus.json');
const OUT_PATH = join(process.cwd(), 'benchmark-result.txt');

/** 状态汇报：带时间戳打一行进度到 stderr，不污染结果文件。 */
function status(step: string): void {
  console.error(`[benchmark ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${step}`);
}

const t0 = Date.now();
status(`开始：理论 benchmark（离线，不调用任何 LLM）`);

status('加载标注语料...');
const corpus = validateCorpus(JSON.parse(readFileSync(CORPUS_PATH, 'utf8')));
status(`语料加载完成：${corpus.length} 条样本`);

interface ThresholdRow {
  threshold: number;
  accuracy: number;
  falseLocal: number;
  falseCloud: number;
  expectedCost: number;
}

// 在多个阈值下扫描，观察准确率与代价的权衡
status('阈值扫描中（0.30 → 0.70，步长 0.05，共 9 档）...');
const rows: ThresholdRow[] = [];
for (let t = 0.30; t <= 0.701; t += 0.05) {
  const q = evaluateCorpus(corpus, { threshold: Number(t.toFixed(2)) });
  rows.push({
    threshold: q.threshold,
    accuracy: q.accuracy,
    falseLocal: q.falseLocal,
    falseCloud: q.falseCloud,
    expectedCost: q.expectedCost,
  });
  status(`阈值 ${q.threshold.toFixed(2)} 完成：accuracy=${(q.accuracy * 100).toFixed(2)}%, expectedCost=${q.expectedCost}`);
}
status('阈值扫描完成，评估默认阈值指标...');

const best = rows.reduce((a, b) => (b.accuracy > a.accuracy ? b : a));
const q = evaluateCorpus(corpus); // 默认阈值下的完整指标

const lines: string[] = [];
lines.push('=== 理论 Benchmark：路由分类器离线评估（不调用任何 LLM） ===');
lines.push(`语料: ${CORPUS_PATH}`);
lines.push(`样本数: ${corpus.length} (local=${corpus.filter((e) => e.expectedRoute === 'local').length}, cloud=${corpus.filter((e) => e.expectedRoute === 'cloud').length})`);
lines.push(`默认阈值: ${DEFAULT_ROUTING_THRESHOLD}, 默认代价模型: falseLocal×${DEFAULT_COST_MODEL.falseLocalWeight} / falseCloud×${DEFAULT_COST_MODEL.falseCloudWeight}`);
lines.push('');
lines.push('--- 默认阈值混淆矩阵 ---');
lines.push(`                 预测local   预测cloud`);
lines.push(`真实local      ${q.trueLocal}          ${q.falseCloud}`);
lines.push(`真实cloud      ${q.falseLocal}          ${q.trueCloud}`);
lines.push('');
lines.push(`准确率 accuracy      = ${(q.accuracy * 100).toFixed(2)}%`);
lines.push(`cloud precision      = ${(q.cloudPrecision * 100).toFixed(2)}%`);
lines.push(`cloud recall         = ${(q.cloudRecall * 100).toFixed(2)}%`);
lines.push(`cloud F1             = ${q.cloudF1.toFixed(4)}`);
lines.push(`期望代价 expectedCost = ${q.expectedCost} (越低越好, 上限 ${corpus.length * DEFAULT_COST_MODEL.falseLocalWeight})`);
lines.push('');
lines.push('--- 阈值扫描 (0.30 → 0.70, 步长 0.05) ---');
lines.push('threshold | accuracy | falseLocal | falseCloud | expectedCost');
for (const r of rows) {
  lines.push(`${String(r.threshold).padEnd(9)} | ${(r.accuracy * 100).toFixed(2).padStart(7)}% | ${String(r.falseLocal).padEnd(10)} | ${String(r.falseCloud).padEnd(10)} | ${r.expectedCost}`);
}
lines.push('');
lines.push(`最优阈值(按准确率): ${best.threshold} → accuracy=${(best.accuracy * 100).toFixed(2)}%, expectedCost=${best.expectedCost}`);

const report = lines.join('\n');
status('写出报告...');
writeFileSync(OUT_PATH, report + '\n', 'utf8');
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n报告已写入: ${OUT_PATH}`);
status(`完成：报告已写入 ${OUT_PATH}，总耗时 ${elapsed}s，结论 accuracy=${(q.accuracy * 100).toFixed(2)}%, expectedCost=${q.expectedCost}`);
