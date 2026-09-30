/**
 * Domain layer: the routing decision itself.
 *
 * This is a pure function of `RequestFeatures` and configuration. No VS Code,
 * no I/O, no globals — the whole policy is trivially unit testable.
 */

import type { RequestFeatures, RouteKind } from './requestClassifier';

export interface RoutingPolicyOptions {
  /** Complexity score at or above which the request goes to the cloud. */
  threshold: number;
  /** When false, everything is forwarded to the cloud. */
  enableLocalRouting: boolean;
}

export const DEFAULT_ROUTING_THRESHOLD = 0.5;

export function normaliseThreshold(threshold: number): number {
  if (!Number.isFinite(threshold)) {
    return DEFAULT_ROUTING_THRESHOLD;
  }
  return Math.min(1, Math.max(0, threshold));
}

/**
 * Decide where a request should be answered.
 *
 * @param features classifier output
 * @param threshold complexity cut-over, 0..1 (defaults to 0.5)
 * @param enableLocalRouting when false the cloud is always chosen
 */
export function decideRoute(
  features: RequestFeatures,
  threshold: number = DEFAULT_ROUTING_THRESHOLD,
  enableLocalRouting: boolean = true
): RouteKind {
  if (!enableLocalRouting) {
    return 'cloud';
  }
  const cut = normaliseThreshold(threshold);
  return features.complexity < cut ? 'local' : 'cloud';
}

export interface RouteDecision {
  route: RouteKind;
  complexity: number;
  threshold: number;
  reason: string;
}

/** Same decision as {@link decideRoute} but with an explanation for the UI. */
export function explainRoute(
  features: RequestFeatures,
  threshold: number = DEFAULT_ROUTING_THRESHOLD,
  enableLocalRouting: boolean = true
): RouteDecision {
  const cut = normaliseThreshold(threshold);
  const route = decideRoute(features, cut, enableLocalRouting);

  let reason: string;
  if (!enableLocalRouting) {
    reason = 'Local routing disabled by configuration';
  } else if (route === 'local') {
    reason = features.hasSimpleIntent
      ? 'Simple intent detected and request fits the local context window'
      : 'Low complexity, answered locally';
  } else if (features.hasComplexIntent) {
    reason = `Complex intent: ${features.complexIntentHits.join(', ')}`;
  } else if (features.isCrossFile) {
    reason = 'Cross-file reasoning exceeds the local routing policy';
  } else {
    reason = `Complexity ${features.complexity.toFixed(2)} >= threshold ${cut.toFixed(2)}`;
  }

  return {
    route,
    complexity: features.complexity,
    threshold: cut,
    reason,
  };
}