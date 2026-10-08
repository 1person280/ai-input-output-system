/**
 * Presentation layer: the dashboard's "routing quality" block.
 *
 * Kept out of `dashboardPanel.ts` so the savings view and the quality view stay
 * independently changeable. Renders nothing but static HTML — the panel runs
 * without scripts under a strict CSP.
 */

import type { OnlineQuality } from '../routing/decisionQuality';
import { escapeHtml } from './htmlEscape';

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function card(label: string, value: string, hint: string): string {
  return `
    <div class="card">
      <div class="card-label">${escapeHtml(label)}</div>
      <div class="card-value">${escapeHtml(value)}</div>
      <div class="card-hint">${escapeHtml(hint)}</div>
    </div>`;
}

export function renderRoutingQualitySection(
  quality: OnlineQuality | null
): string {
  if (!quality || quality.decided === 0) {
    return '<p class="empty">No routing decisions recorded yet.</p>';
  }

  const failureValue =
    quality.localWithFeedback === 0 ? 'n/a' : percent(quality.localFailureRate);
  const failureHint =
    quality.localWithFeedback === 0
      ? 'no local feedback collected yet'
      : quality.reliable
        ? `${quality.localRejections} of ${quality.localWithFeedback} local answers rejected`
        : `low sample (coverage ${percent(quality.coverage)}) — indicative only`;

  const cards = [
    card('Local failure rate', failureValue, failureHint),
    card(
      'Fallback rate',
      percent(quality.fallbackRate),
      `${quality.fallbackCount} of ${quality.localAttempts} local attempts`
    ),
    card(
      'Feedback coverage',
      percent(quality.coverage),
      `${quality.withFeedback} of ${quality.decided} decisions`
    ),
  ];

  return `<div class="cards">${cards.join('')}</div>`;
}
