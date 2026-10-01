/**
 * Domain layer: pure, framework-free feature extraction.
 *
 * `classify` turns a raw prompt plus a light-weight editor context into a
 * `RequestFeatures` value object. It never touches the VS Code API so it can be
 * unit tested in a plain Node process.
 *
 * Both the coefficients ({@link ClassifierWeights}) and the vocabulary
 * ({@link IntentLexicon}) are injectable; the defaults reproduce the original
 * hand-tuned behaviour exactly.
 */

import {
  ClassifierWeights,
  normaliseWeights,
} from './classifierWeights';
import {
  CompiledIntentPattern,
  CompiledLexicon,
  compileLexicon,
  DEFAULT_INTENT_LEXICON,
  IntentLexicon,
} from './intentLexicon';

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

export interface ClassifyOptions {
  /** Partial override merged onto {@link DEFAULT_CLASSIFIER_WEIGHTS}. */
  weights?: Partial<ClassifierWeights>;
  /** Replacement vocabulary; defaults to {@link DEFAULT_INTENT_LEXICON}. */
  lexicon?: IntentLexicon;
}

const DEFAULT_COMPILED = compileLexicon(DEFAULT_INTENT_LEXICON);

/** CJK ideographs are roughly one token each; latin text is ~4 chars/token. */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/** File extensions that, when mentioned, imply cross-file reasoning. */
const MENTIONED_FILE_PATTERN =
  /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|rb|php|md)\b/g;

export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const cjkMatches = text.match(CJK_PATTERN);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount + otherCount / 4);
}

function collectHits(
  text: string,
  patterns: ReadonlyArray<CompiledIntentPattern>
): string[] {
  const hits: string[] = [];
  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      hits.push(pattern.label);
    }
  }
  return hits;
}

function countStrength(
  patterns: ReadonlyArray<CompiledIntentPattern>,
  text: string,
  strength: 'strong' | 'weak'
): number {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.strength === strength && pattern.regex.test(text)) {
      count += 1;
    }
  }
  return count;
}

export function classify(
  text: string,
  context: EditorContext = {},
  options: ClassifyOptions = {}
): RequestFeatures {
  const prompt = text ?? '';
  const referenced = context.selectedText ?? context.fileText ?? '';
  const estimatedTokens = estimateTokens(prompt) + estimateTokens(referenced);

  const fileCount = Math.max(1, context.fileCount ?? 1);
  const isMultiFile = fileCount > 1;
  const mentionedFiles = new Set(prompt.match(MENTIONED_FILE_PATTERN) ?? []);
  if (context.fileName) {
    mentionedFiles.delete(context.fileName);
  }
  const isCrossFile = mentionedFiles.size > 0 || isMultiFile;

  const lexicon: CompiledLexicon = options.lexicon
    ? compileLexicon(options.lexicon)
    : DEFAULT_COMPILED;
  const weights = normaliseWeights(options.weights);

  const complexIntentHits = collectHits(prompt, lexicon.complex);
  const simpleIntentHits = collectHits(prompt, lexicon.simple);
  const hasComplexIntent = complexIntentHits.length > 0;
  const hasSimpleIntent = simpleIntentHits.length > 0;

  const strongComplex = countStrength(lexicon.complex, prompt, 'strong');
  const weakComplex = countStrength(lexicon.complex, prompt, 'weak');

  const complexity = computeComplexity(
    {
      estimatedTokens,
      isMultiFile,
      isCrossFile,
      hasComplexIntent,
      hasSimpleIntent,
      strongComplex,
      weakComplex,
    },
    weights
  );

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
  strongComplex: number;
  weakComplex: number;
}

/**
 * How much repeated complex-intent hits amplify the base bonus. A single hit
 * (strong or weak) yields 1 — i.e. the historical boolean behaviour — while
 * several strong hits push towards {@link ClassifierWeights.maxIntentMultiplier}.
 */
function intentIntensity(input: ComplexityInput, weights: ClassifierWeights): number {
  const raw = input.strongComplex + input.weakComplex * weights.weakIntentScale;
  return Math.min(weights.maxIntentMultiplier, Math.max(1, raw));
}

function computeComplexity(
  input: ComplexityInput,
  weights: ClassifierWeights
): number {
  // Start in the middle, then push towards 0 (local) or 1 (cloud).
  let score = weights.baseScore;

  const tokenPressure = input.estimatedTokens / weights.localContextTokens;
  score += Math.min(weights.tokenPressureCap, tokenPressure * weights.tokenPressureScale);

  if (input.isMultiFile) {
    score += weights.multiFileBonus;
  }
  if (input.isCrossFile) {
    score += weights.crossFileBonus;
  }
  if (input.hasComplexIntent) {
    score += weights.complexIntentBonus * intentIntensity(input, weights);
  }
  // A cosmetic ask tacked onto a hard task ("refactor this and add comments")
  // must not cancel the complexity signal, so the simple penalty only applies
  // when nothing complex was detected at all.
  if (input.hasSimpleIntent && !input.hasComplexIntent) {
    score -= weights.simpleIntentPenalty;
  }
  if (
    input.hasSimpleIntent &&
    !input.hasComplexIntent &&
    input.estimatedTokens < weights.smallSimpleTokenLimit
  ) {
    score -= weights.smallSimpleBonus;
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
