import { describe, expect, it } from 'vitest';
import { isSafeRelativePath } from './filePlan';
import { planFromRequirement } from './heuristicPlanner';

describe('planFromRequirement', () => {
  it('uses the file name referenced in the requirement', () => {
    const plan = planFromRequirement('请创建 main.py 用于读取数据');
    expect(plan.source).toBe('heuristic');
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].path).toBe('main.py');
  });

  it('supports multiple referenced file names', () => {
    const paths = planFromRequirement('生成 hello.py 和 README.md').files.map(
      (file) => file.path
    );
    expect(paths).toContain('hello.py');
    expect(paths).toContain('README.md');
  });

  it('infers main.py for python/script keywords', () => {
    expect(planFromRequirement('写一个 python 数据处理脚本').files[0].path).toBe('main.py');
  });

  it('infers README.md for readme keywords', () => {
    expect(planFromRequirement('帮我写一份 readme 说明').files[0].path).toBe('README.md');
  });

  it('infers main.ts for typescript keywords', () => {
    expect(planFromRequirement('创建一个 typescript 模块').files[0].path).toBe('main.ts');
  });

  it('infers config.json for json keywords', () => {
    expect(planFromRequirement('生成一份 json 配置').files[0].path).toBe('config.json');
  });

  it('falls back to notes.md when nothing matches', () => {
    expect(planFromRequirement('随便写点东西').files[0].path).toBe('notes.md');
  });

  it('embeds the requirement verbatim in the generated content', () => {
    const requirement = '读取 CSV 并输出每列摘要';
    const plan = planFromRequirement(`请创建 summary.py：${requirement}`);
    expect(plan.files[0].content).toContain(requirement);
    expect(plan.requirement).toBe(`请创建 summary.py：${requirement}`);
  });

  it('always produces safe relative paths', () => {
    const plan = planFromRequirement('生成 src/app/main.ts 与 /etc/bad.md');
    for (const file of plan.files) {
      expect(isSafeRelativePath(file.path)).toBe(true);
      expect(file.path.startsWith('/')).toBe(false);
    }
  });

  it('produces valid JSON content for json files', () => {
    const plan = planFromRequirement('创建 config.json');
    expect(() => JSON.parse(plan.files[0].content)).not.toThrow();
  });
});