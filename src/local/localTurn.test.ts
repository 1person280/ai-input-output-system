import { describe, expect, it } from 'vitest';
import {
  ESCALATE_MARKER,
  parseLocalTurn,
} from './localModelClient';

describe('parseLocalTurn', () => {
  it('普通回答：无标记时返回正文', () => {
    const turn = parseLocalTurn('把函数改成 async 的即可。');
    expect(turn).toEqual({ kind: 'answer', text: '把函数改成 async 的即可。' });
  });

  it('求助：标记后的内容是子问题', () => {
    const turn = parseLocalTurn(`让我想想。\n${ESCALATE_MARKER}：如何把整个模块重构为依赖注入风格？`);
    expect(turn.kind).toBe('escalate');
    if (turn.kind === 'escalate') {
      expect(turn.request.reason).toContain('依赖注入');
    }
  });

  it('求助：标记前正文并入子问题，不丢上下文', () => {
    const turn = parseLocalTurn(`${ESCALATE_MARKER}这个跨文件重构应该怎么拆分？`);
    expect(turn.kind).toBe('escalate');
    if (turn.kind === 'escalate') {
      expect(turn.request.reason).toBe('这个跨文件重构应该怎么拆分？');
    }
  });

  it('只有标记没有任何内容：视为空回答', () => {
    const turn = parseLocalTurn(ESCALATE_MARKER);
    expect(turn).toEqual({ kind: 'answer', text: '' });
  });
});
