/**
 * Domain layer: pure, framework-free feature extraction.
 *
 * `classify` turns a raw prompt plus a light-weight editor context into a
 * `RequestFeatures` value object. It never touches the VS Code API so it can be
 * unit tested in a plain Node process.
 */

export type RouteKind = 'local' | 'cloud';

export interface EditorContext {
  /** Name of the active file, used only for logging / heuristics. */
  fileName?: string;
  languageId?: string;
  /** Currently selected text in the editor. */
  selectedText?: string;
  /** Full text of the active file, used to estimate context size. */
  fileText?: string;
  /** Number of files that the request appears to touch. */
  fileCount?: number;
}

export interface RequestFeatures {
  /** Rough token estimate for the whole request (prompt + referenced code). */
  estimatedTokens: number;
  isMultiFile: boolean;
  isCrossFile: boolean;
  hasComplexIntent: boolean;
  hasSimpleIntent: boolean;
  complexIntentHits: string[];
  simpleIntentHits: string[];
  /** Complexity score in [0, 1]. Higher means "more likely to need the cloud". */
  complexity: number;
}

const COMPLEX_INTENT_PATTERNS: ReadonlyArray<RegExp> = [
  /\brefactor(?:ing)?\b/i,
  /\barchitect(?:ure|ing)?\b/i,
  /\bdesign\b/i,
  /\bdebug(?:ging)?\b/i,
  /\bmigrat(?:e|ion|ing)\b/i,
  /\boptimi[sz]e\b/i,
  /\bperformance\b/i,
  /\bconcurren(?:cy|t)\b/i,
  /\bthread[- ]?safety\b/i,
  /\bsolid\b/i,
  /\bcoverage\b/i,
  /\breview\b/i,
  /\btrace\b/i,
  /\bprove\b/i,
  /重构/,
  /架构/,
  /设计模式|设计/,
  /调试/,
  /迁移/,
  /优化/,
  /性能/,
  /并发|多线程/,
  /算法/,
  /复杂度/,
  /安全漏洞|安全审计/,
  /覆盖率/,
  /帮我审查|代码审查/,
  /为什么|原理|底层/,
];

const SIMPLE_INTENT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bformat(?:ting)?\b/i,
  /\bindent(?:ation)?\b/i,
  /\brename\b/i,
  /\bcomment(?:s|ing)?\b/i,
  /\bdocstring\b/i,
  /\bspell(?:ing)?\b/i,
  /\btypo\b/i,
  /\badd\s+log(?:ging|s)?\b/i,
  /格式化/,
  /排版/,
  /缩进/,
  /改名|重命名/,
  /加注释|补注释|写注释/,
  /拼写|错别字/,
  /加日志|打日志/,
  /补全/,
];

/** CJK ideographs are roughly one token each; latin text is ~4 chars/token. */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const cjkMatches = text.match(CJK_PATTERN);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount + otherCount / 4);
}

function collectMatches(text: string, patterns: ReadonlyArray<RegExp>): string[] {
  const hits: string[] = [];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      hits.push(match[0]);
    }
  }
  return hits;
}

export function classify(text: string, context: EditorContext = {}): RequestFeatures {
  const prompt = text ?? '';
  const referenced = context.selectedText ?? context.fileText ?? '';
  const estimatedTokens =
    estimateTokens(prompt) + estimateTokens(referenced);

  const fileCount = Math.max(1, context.fileCount ?? 1);
  const isMultiFile = fileCount > 1;
  const mentionsOtherFiles = /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|rb|php|md)\b/g;
  const mentionedFiles = new Set(prompt.match(mentionsOtherFiles) ?? []);
  if (context.fileName) {
    mentionedFiles.delete(context.fileName);
  }
  const isCrossFile = mentionedFiles.size > 0 || isMultiFile;

  const complexIntentHits = collectMatches(prompt, COMPLEX_INTENT_PATTERNS);
  const simpleIntentHits = collectMatches(prompt, SIMPLE_INTENT_PATTERNS);

  const hasComplexIntent = complexIntentHits.length > 0;
  const hasSimpleIntent = simpleIntentHits.length > 0;

  const complexity = computeComplexity({
    estimatedTokens,
    isMultiFile,
    isCrossFile,
    hasComplexIntent,
    hasSimpleIntent,
  });

  return {
    estimatedTokens,
    isMultiFile,
    isCrossFile,
    hasComplexIntent,
    hasSimpleIntent,
    complexIntentHits,
    simpleIntentHits,
    complexity,
  };
}

interface ComplexityInput {
  estimatedTokens: number;
  isMultiFile: boolean;
  isCrossFile: boolean;
  hasComplexIntent: boolean;
  hasSimpleIntent: boolean;
}

/** Reference context window for the bundled local model. */
const LOCAL_CONTEXT_TOKENS = 65536;

function computeComplexity(input: ComplexityInput): number {
  // Start in the middle, then push towards 0 (local) or 1 (cloud).
  let score = 0.5;

  const tokenPressure = input.estimatedTokens / LOCAL_CONTEXT_TOKENS;
  score += Math.min(0.3, tokenPressure * 10);

  if (input.isMultiFile) {
    score += 0.12;
  }
  if (input.isCrossFile) {
    score += 0.1;
  }
  if (input.hasComplexIntent) {
    score += 0.3;
  }
  if (input.hasSimpleIntent) {
    score -= 0.35;
  }
  if (
    input.hasSimpleIntent &&
    !input.hasComplexIntent &&
    input.estimatedTokens < 2048
  ) {
    score -= 0.15;
  }

  return clamp01(score);
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}