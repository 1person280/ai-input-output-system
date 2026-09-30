import { describe, expect, it } from 'vitest';
import { classify, estimateTokens } from './requestClassifier';

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('approximates latin text at ~4 characters per token', () => {
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('counts CJK characters as roughly one token each', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });
});

describe('classify', () => {
  it('flags formatting requests as simple', () => {
    const features = classify('Format this function and fix the indentation');
    expect(features.hasSimpleIntent).toBe(true);
    expect(features.hasComplexIntent).toBe(false);
    expect(features.complexity).toBeLessThan(0.5);
  });

  it('flags refactoring requests as complex', () => {
    const features = classify('Refactor this module and improve overall performance');
    expect(features.hasComplexIntent).toBe(true);
    expect(features.complexIntentHits.length).toBeGreaterThan(0);
    expect(features.complexity).toBeGreaterThan(0.5);
  });

  it('detects Chinese complex intent keywords', () => {
    const features = classify('帮我重构这段代码，并考虑并发安全和性能');
    expect(features.hasComplexIntent).toBe(true);
  });

  it('treats a rename request on a small snippet as simple', () => {
    const features = classify('rename this variable to totalCount', {
      selectedText: 'const n = 1;',
    });
    expect(features.hasSimpleIntent).toBe(true);
    expect(features.complexity).toBeLessThan(0.5);
  });

  it('marks requests that mention another file as cross-file', () => {
    const features = classify('Make src/other/module.ts use the same interface', {
      fileName: 'src/main/index.ts',
    });
    expect(features.isCrossFile).toBe(true);
  });

  it('does not treat the active file itself as cross-file', () => {
    const features = classify('Explain src/main/index.ts', {
      fileName: 'src/main/index.ts',
    });
    expect(features.isCrossFile).toBe(false);
  });

  it('adds token pressure from the referenced code', () => {
    const features = classify('explain', { fileText: 'a'.repeat(4000) });
    expect(features.estimatedTokens).toBeGreaterThanOrEqual(1000);
  });

  it('keeps complexity inside [0, 1]', () => {
    const features = classify(
      'refactor, architecture, migration, concurrency, optimize, debug, security review',
      { fileText: 'x'.repeat(200_000), fileCount: 12 }
    );
    expect(features.complexity).toBeGreaterThanOrEqual(0);
    expect(features.complexity).toBeLessThanOrEqual(1);
  });
});