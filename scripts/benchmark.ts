/**
 * Benchmark: 插件链路（本地小模型先行，必要时升级专家） vs 纯云端（大模型直接答）。
 *
 * 运行：先 npx esbuild 打包再 node 执行（见 package.json scripts.benchmark）。
 * 说明：本机没有真实云端 key，用 Ollama 的大模型（qwen2.5:3b）模拟远程专家/
 * 纯云端，小模型（qwen2.5:1b）模拟本地模型。对比口径是 token 用量与时延。
 */

import { CloudClient } from '../src/cloud/cloudClient';
import { LocalModelClient } from '../src/local/localModelClient';
import { parseLocalTurn, ESCALATION_SYSTEM_PROMPT } from '../src/local/localModelClient';
import { Router } from '../src/routing/router';
import type { ChatMessage } from '../src/cloud/cloudClient';

const OLLAMA = 'http://127.0.0.1:11434/v1';
const OLLAMA_BASE = 'http://127.0.0.1:11434';
const LOCAL_MODEL = 'qwen2.5:0.5b';
const CLOUD_MODEL = 'qwen2.5:1.5b';

/** 待测代码任务：跨文件重构类（复杂任务，本地大概率需要求助）。 */
const TASK_PROMPT = [
  '我有一个 TypeScript 项目，里面有 12 个文件互相 import。',
  '请给出一个方案：把散落在各文件里的日期格式化逻辑统一收敛到一个 utils/date.ts 模块，',
  '要求保持既有调用方签名不变、说明迁移步骤和风险点。',
].join('\n');

const SYSTEM = 'You are a concise coding assistant. Answer in Chinese.';

function messages(): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: TASK_PROMPT },
  ];
}

interface RunStat {
  label: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  escalated: boolean;
}

function sum(runs: RunStat[], key: 'promptTokens' | 'completionTokens' | 'totalTokens' | 'latencyMs'): number {
  return runs.reduce((acc, r) => acc + r[key], 0);
}

async function main(): Promise<void> {
  const cloud = new CloudClient({ baseUrl: OLLAMA, apiKey: '', model: CLOUD_MODEL, timeoutMs: 600_000 });
  const local = new LocalModelClient({ serverUrl: OLLAMA_BASE, model: LOCAL_MODEL, timeoutMs: 600_000 });

  const router = new Router({
    cloud,
    local,
    ledger: { record: () => {} },
    options: { escalationEnabled: true, fallbackToCloud: true },
  });

  const pluginRuns: RunStat[] = [];
  const cloudRuns: RunStat[] = [];
  const ROUNDS = 1;

  for (let i = 0; i < ROUNDS; i++) {
    // ---- 插件链路：本地先行 -> 升级检测 -> 专家 -> 整合 ----
    const t0 = Date.now();
    let escalated = false;
    let pTokens = 0;
    let cTokens = 0;

    const first = await local.complete(messages(), 'chat-completions', undefined, { escalate: true });
    pTokens += first.promptTokens ?? 0;
    cTokens += first.completionTokens ?? 0;
    const turn = parseLocalTurn(first.text);

    if (turn.kind === 'escalate') {
      escalated = true;
      const expert = await cloud.complete([
        { role: 'system', content: 'You are a remote expert assistant. Answer the focused question precisely and concisely, in Chinese.' },
        { role: 'user', content: turn.request.reason },
      ]);
      pTokens += expert.promptTokens ?? 0;
      cTokens += expert.completionTokens ?? 0;

      const synth = await local.complete([
        ...messages(),
        { role: 'assistant', content: `[ESCALATE] ${turn.request.reason}` },
        { role: 'user', content: `远程专家回答了你的子问题：\n\n${expert.text}\n\n请结合该答案，用中文给出对原始请求的最终回复。` },
      ], 'chat-completions', undefined, { escalate: true });
      pTokens += synth.promptTokens ?? 0;
      cTokens += synth.completionTokens ?? 0;
    }

    pluginRuns.push({
      label: 'plugin',
      latencyMs: Date.now() - t0,
      promptTokens: pTokens,
      completionTokens: cTokens,
      totalTokens: pTokens + cTokens,
      escalated,
    });

    // ---- 纯云端：大模型直接完整作答 ----
    const t1 = Date.now();
    const direct = await cloud.complete(messages());
    cloudRuns.push({
      label: 'cloud',
      latencyMs: Date.now() - t1,
      promptTokens: direct.promptTokens ?? 0,
      completionTokens: direct.completionTokens ?? 0,
      totalTokens: (direct.promptTokens ?? 0) + (direct.completionTokens ?? 0),
      escalated: false,
    });
  }

  const pTotal = sum(pluginRuns, 'totalTokens');
  const cTotal = sum(cloudRuns, 'totalTokens');
  const saving = cTotal === 0 ? 0 : 1 - pTotal / cTotal;

  console.log('=== Benchmark: 插件链路(本地qwen2.5:1b) vs 纯云端(模拟qwen2.5:3b) ===');
  console.log(`任务: 跨文件日期工具收敛重构 (${TASK_PROMPT.length} 字符提示词), ${ROUNDS} 轮\n`);
  console.log('插件链路:');
  pluginRuns.forEach((r, i) =>
    console.log(`  第${i + 1}轮 escalated=${r.escalated} tokens=${r.totalTokens} (prompt ${r.promptTokens} / completion ${r.completionTokens}) ${r.latencyMs}ms`)
  );
  console.log('纯云端:');
  cloudRuns.forEach((r, i) =>
    console.log(`  第${i + 1}轮 tokens=${r.totalTokens} (prompt ${r.promptTokens} / completion ${r.completionTokens}) ${r.latencyMs}ms`)
  );
  console.log('\n汇总:');
  console.log(`  插件链路 total tokens = ${pTotal}`);
  console.log(`  纯云端   total tokens = ${cTotal}`);
  console.log(`  token 节省率 = ${(saving * 100).toFixed(1)}%`);
  console.log(`  平均时延 插件 ${Math.round(sum(pluginRuns, 'latencyMs') / ROUNDS)}ms vs 云端 ${Math.round(sum(cloudRuns, 'latencyMs') / ROUNDS)}ms`);
}

main().catch((error) => {
  console.error('benchmark failed:', error);
  process.exit(1);
});
