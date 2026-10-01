/**
 * Domain layer: the intent vocabulary behind complexity scoring.
 *
 * Patterns are data, not code. Each complex pattern carries a `strength` so an
 * unambiguous signal ("refactor", "重构") counts more than an ambiguous one
 * ("design", "设计"), which otherwise misfires on prompts like "design a
 * variable name". The compiled form is cached per lexicon instance.
 */

export type IntentStrength = 'strong' | 'weak';

export interface IntentPattern {
  /** Canonical keyword surfaced in `RequestFeatures.*IntentHits`. */
  label: string;
  /** Regular-expression source; compiled with {@link IntentPattern.flags}. */
  source: string;
  flags: string;
  strength: IntentStrength;
}

export interface IntentLexicon {
  complex: ReadonlyArray<IntentPattern>;
  simple: ReadonlyArray<IntentPattern>;
}

export interface CompiledIntentPattern {
  label: string;
  strength: IntentStrength;
  regex: RegExp;
}

export interface CompiledLexicon {
  complex: ReadonlyArray<CompiledIntentPattern>;
  simple: ReadonlyArray<CompiledIntentPattern>;
}

const CASELESS = 'i';

/** Complex-intent vocabulary. Chinese entries carry no flags and match literally. */
export const DEFAULT_COMPLEX_PATTERNS: ReadonlyArray<IntentPattern> = [
  { label: 'refactor', source: '\\brefactor(?:ing)?\\b', flags: CASELESS, strength: 'strong' },
  { label: 'architect', source: '\\barchitect(?:ure|ing)?\\b', flags: CASELESS, strength: 'strong' },
  { label: 'debug', source: '\\bdebug(?:ging)?\\b', flags: CASELESS, strength: 'strong' },
  { label: 'migrate', source: '\\bmigrat(?:e|ion|ing)\\b', flags: CASELESS, strength: 'strong' },
  { label: 'optimize', source: '\\boptimi[sz]e\\b', flags: CASELESS, strength: 'strong' },
  { label: 'performance', source: '\\bperformance\\b', flags: CASELESS, strength: 'strong' },
  { label: 'concurrency', source: '\\bconcurren(?:cy|t)\\b', flags: CASELESS, strength: 'strong' },
  { label: 'thread-safety', source: '\\bthread[- ]?safe(?:ty)?\\b', flags: CASELESS, strength: 'strong' },
  { label: 'solid', source: '\\bsolid\\b', flags: CASELESS, strength: 'strong' },
  { label: 'coverage', source: '\\bcoverage\\b', flags: CASELESS, strength: 'strong' },
  { label: 'trace', source: '\\btrace\\b', flags: CASELESS, strength: 'strong' },
  { label: 'prove', source: '\\bprove\\b', flags: CASELESS, strength: 'strong' },
  { label: 'design', source: '\\bdesign\\b', flags: CASELESS, strength: 'weak' },
  { label: 'review', source: '\\breview\\b', flags: CASELESS, strength: 'weak' },
  { label: '重构', source: '重构', flags: '', strength: 'strong' },
  { label: '架构', source: '架构', flags: '', strength: 'strong' },
  { label: '调试', source: '调试', flags: '', strength: 'strong' },
  { label: '迁移', source: '迁移', flags: '', strength: 'strong' },
  { label: '优化', source: '优化', flags: '', strength: 'strong' },
  { label: '性能', source: '性能', flags: '', strength: 'strong' },
  { label: '并发', source: '并发|多线程', flags: '', strength: 'strong' },
  { label: '算法', source: '算法', flags: '', strength: 'strong' },
  { label: '复杂度', source: '复杂度', flags: '', strength: 'strong' },
  { label: '安全审计', source: '安全漏洞|安全审计', flags: '', strength: 'strong' },
  { label: '覆盖率', source: '覆盖率', flags: '', strength: 'strong' },
  { label: '代码审查', source: '代码审查|帮我审查', flags: '', strength: 'strong' },
  { label: '设计', source: '设计模式|设计', flags: '', strength: 'weak' },
  { label: '原理', source: '为什么|原理|底层', flags: '', strength: 'weak' },
];

/** Simple-intent vocabulary: formatting, renames, comments, spelling. */
export const DEFAULT_SIMPLE_PATTERNS: ReadonlyArray<IntentPattern> = [
  { label: 'format', source: '\\bformat(?:ting)?\\b', flags: CASELESS, strength: 'strong' },
  { label: 'indent', source: '\\bindent(?:ation)?\\b', flags: CASELESS, strength: 'strong' },
  { label: 'rename', source: '\\brename\\b', flags: CASELESS, strength: 'strong' },
  { label: 'comment', source: '\\bcomment(?:s|ing)?\\b', flags: CASELESS, strength: 'strong' },
  { label: 'docstring', source: '\\bdocstring\\b', flags: CASELESS, strength: 'strong' },
  { label: 'spelling', source: '\\bspell(?:ing)?\\b', flags: CASELESS, strength: 'strong' },
  { label: 'typo', source: '\\btypo\\b', flags: CASELESS, strength: 'strong' },
  { label: 'add-logs', source: '\\badd\\s+log(?:ging|s)?\\b', flags: CASELESS, strength: 'strong' },
  { label: '格式化', source: '格式化', flags: '', strength: 'strong' },
  { label: '排版', source: '排版', flags: '', strength: 'strong' },
  { label: '缩进', source: '缩进', flags: '', strength: 'strong' },
  { label: '重命名', source: '改名|重命名', flags: '', strength: 'strong' },
  { label: '注释', source: '加注释|补注释|写注释', flags: '', strength: 'strong' },
  { label: '拼写', source: '拼写|错别字', flags: '', strength: 'strong' },
  { label: '日志', source: '加日志|打日志', flags: '', strength: 'strong' },
  { label: '补全', source: '补全', flags: '', strength: 'strong' },
];

export const DEFAULT_INTENT_LEXICON: IntentLexicon = {
  complex: DEFAULT_COMPLEX_PATTERNS,
  simple: DEFAULT_SIMPLE_PATTERNS,
};

function compile(
  patterns: ReadonlyArray<IntentPattern>
): ReadonlyArray<CompiledIntentPattern> {
  return patterns.map((pattern) => ({
    label: pattern.label,
    strength: pattern.strength,
    regex: new RegExp(pattern.source, pattern.flags),
  }));
}

const compiledCache = new WeakMap<IntentLexicon, CompiledLexicon>();

/** Compile a lexicon once and memoise it by object identity. */
export function compileLexicon(lexicon: IntentLexicon): CompiledLexicon {
  const cached = compiledCache.get(lexicon);
  if (cached) {
    return cached;
  }
  const compiled: CompiledLexicon = {
    complex: compile(lexicon.complex),
    simple: compile(lexicon.simple),
  };
  compiledCache.set(lexicon, compiled);
  return compiled;
}
