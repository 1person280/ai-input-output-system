import { describe, expect, it } from 'vitest';
import { parseModelPlan } from './planParser';

const requirement = '创建一个 python 脚本读取数据';

describe('parseModelPlan', () => {
  it('parses a plain JSON object', () => {
    const raw = JSON.stringify({
      files: [{ path: 'main.py', content: 'print(1)' }],
    });
    const plan = parseModelPlan(raw, requirement, 'local');
    expect(plan).not.toBeNull();
    expect(plan?.files).toHaveLength(1);
    expect(plan?.files[0]).toEqual({ path: 'main.py', content: 'print(1)' });
    expect(plan?.source).toBe('local');
    expect(plan?.requirement).toBe(requirement);
  });

  it('parses JSON wrapped in a ```json fence', () => {
    const raw = '```json\n{"files":[{"path":"notes.md","content":"# hi"}]}\n```';
    const plan = parseModelPlan(raw, requirement, 'cloud');
    expect(plan?.files[0].path).toBe('notes.md');
    expect(plan?.source).toBe('cloud');
  });

  it('ignores chatter around the JSON payload', () => {
    const raw =
      'Sure! Here is the plan you asked for:\n' +
      '{"files":[{"path":"main.ts","content":"export {};"}]}\n' +
      'Let me know if you need more.';
    const plan = parseModelPlan(raw, requirement, 'local');
    expect(plan?.files[0].path).toBe('main.ts');
  });

  it('accepts a top-level array of files', () => {
    const raw = '[{"path":"config.json","content":"{}"}]';
    const plan = parseModelPlan(raw, requirement, 'cloud');
    expect(plan?.files[0].path).toBe('config.json');
  });

  it('returns null for non-JSON text', () => {
    expect(parseModelPlan('sorry, I cannot help with that', requirement, 'local')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(
      parseModelPlan('{"files":[{"path":"a.py","content":', requirement, 'local')
    ).toBeNull();
  });

  it('rejects paths that escape the workspace with ..', () => {
    const raw = '{"files":[{"path":"../evil.py","content":"boom"}]}';
    expect(parseModelPlan(raw, requirement, 'local')).toBeNull();
  });

  it('rejects absolute paths', () => {
    const raw = '{"files":[{"path":"/etc/passwd","content":"boom"}]}';
    expect(parseModelPlan(raw, requirement, 'local')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseModelPlan('', requirement, 'local')).toBeNull();
  });
});