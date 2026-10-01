/**
 * Domain layer: the labelled corpus used for offline calibration.
 *
 * The online journal can only confirm false-locals (a rejected local answer).
 * Closing the loop needs ground truth for both classes, which is what this
 * corpus provides: `expectedRoute` answers "was the local 4B model up to this
 * prompt?". The JSON file is read by tests/scripts (Node I/O), never by the
 * domain — `validateCorpus` takes already-parsed data.
 */

import type { RouteKind } from './requestClassifier';

export interface LabeledPrompt {
  /** The prompt exactly as a user would type it. */
  prompt: string;
  /** Ground truth: `local` means the local model was judged capable. */
  expectedRoute: RouteKind;
  /** Short justification, kept so the label can be reviewed later. */
  note?: string;
}

function isRouteKind(value: unknown): value is RouteKind {
  return value === 'local' || value === 'cloud';
}

/**
 * Validate untyped corpus data (e.g. parsed JSON). Entries that are malformed
 * are dropped rather than throwing, so one bad line cannot break calibration.
 */
export function validateCorpus(raw: unknown): LabeledPrompt[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const corpus: LabeledPrompt[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const entry = item as Partial<LabeledPrompt>;
    if (typeof entry.prompt !== 'string' || entry.prompt.length === 0) {
      continue;
    }
    if (!isRouteKind(entry.expectedRoute)) {
      continue;
    }
    corpus.push({
      prompt: entry.prompt,
      expectedRoute: entry.expectedRoute,
      note: typeof entry.note === 'string' ? entry.note : undefined,
    });
  }
  return corpus;
}
