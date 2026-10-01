import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateCorpus } from './decisionQuality';
import { validateCorpus } from './labeledCorpus';

const CORPUS_PATH = join(
  process.cwd(),
  'src',
  'routing',
  'corpus',
  'routingCorpus.json'
);

function loadCorpus() {
  return validateCorpus(JSON.parse(readFileSync(CORPUS_PATH, 'utf8')));
}

describe('labelled routing corpus', () => {
  it('parses with every entry intact', () => {
    const raw = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as unknown[];
    const corpus = loadCorpus();
    expect(corpus.length).toBe(raw.length);
    expect(corpus.length).toBeGreaterThanOrEqual(100);
  });

  it('covers both classes', () => {
    const corpus = loadCorpus();
    expect(corpus.some((entry) => entry.expectedRoute === 'local')).toBe(true);
    expect(corpus.some((entry) => entry.expectedRoute === 'cloud')).toBe(true);
  });

  it('drops malformed entries instead of throwing', () => {
    expect(validateCorpus('not an array')).toEqual([]);
    expect(validateCorpus([{ prompt: 'x', expectedRoute: 'elsewhere' }])).toEqual([]);
    expect(validateCorpus([{ expectedRoute: 'local' }])).toEqual([]);
  });

  // Regression gate: any change to the lexicon or weights that degrades routing
  // quality fails the build here. With 125 labelled prompts the defaults score a
  // clean 1.0 / 0 / 0, so the 0.95 bar allows only a handful of slips and the
  // asymmetric cost cap keeps a single false-local from hiding behind them.
  // Keep it in sync with the tuned defaults in `classifierWeights.ts`.
  it('holds the calibration quality bar', () => {
    const quality = evaluateCorpus(loadCorpus());
    expect(quality.accuracy).toBeGreaterThanOrEqual(0.95);
    expect(quality.falseLocal).toBeLessThanOrEqual(1);
    expect(quality.expectedCost).toBeLessThanOrEqual(3);
  });
});
