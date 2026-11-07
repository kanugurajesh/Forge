import type { Health, StepHealth } from "./types.ts";

/**
 * Drift health. `recordResolution` and the degradation thresholds are a
 * faithful port of BrowserOps' src/procedures/health.ts so the Hub demotes
 * procedures at exactly the point the local runtime would.
 */
export const RELOCATE_RATE_THRESHOLD = 0.4;
export const RELOCATE_MIN_RUNS = 5;
export const FRAGILE_RELOCATE_RATE_THRESHOLD = 0.1;
export const TARGET_CHANGE_MIN_RUNS = 3;

export interface ResolutionRecord {
  match_count: number;
  used_relocate: boolean;
  matched_ref: number;
  tier: 1 | 2 | 3;
}

export function emptyHealth(updated: string): Health {
  return { updated, steps: {} };
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

export function recordResolution(prev: Health, stepId: string, record: ResolutionRecord, at: string): Health {
  const existing = prev.steps[stepId];
  const prevRuns = existing?.runs ?? 0;
  const prevAvg = existing?.avg_match_count ?? record.match_count;
  const nextRuns = prevRuns + 1;
  const nextAvg = prevRuns === 0 ? record.match_count : (prevAvg * prevRuns + record.match_count) / nextRuns;
  const next: StepHealth = {
    runs: nextRuns,
    relocates: (existing?.relocates ?? 0) + (record.used_relocate ? 1 : 0),
    ambiguous_resolves: (existing?.ambiguous_resolves ?? 0) + (record.match_count > 1 ? 1 : 0),
    target_changed:
      (existing?.target_changed ?? 0) + (existing?.last_ref !== undefined && existing.last_ref !== record.matched_ref ? 1 : 0),
    avg_match_count: round(nextAvg, 3),
    last_tier: record.tier,
    last_ref: record.matched_ref,
  };
  return { updated: at, steps: { ...prev.steps, [stepId]: next } };
}

/** Why a step is degraded, or null when healthy. Mirrors isStepDegraded(). */
export function degradeReason(step: StepHealth): string | null {
  if (step.runs >= RELOCATE_MIN_RUNS) {
    const rate = step.relocates / step.runs;
    if (rate > RELOCATE_RATE_THRESHOLD)
      return `relocate rate ${(rate * 100).toFixed(0)}% > ${RELOCATE_RATE_THRESHOLD * 100}% over ${step.runs} runs`;
  }
  if (step.runs >= TARGET_CHANGE_MIN_RUNS && step.target_changed > 0)
    return `target changed ${step.target_changed}× across ${step.runs} runs`;
  if (step.last_tier === 3 && step.runs > 0) {
    const rate = step.relocates / step.runs;
    if (rate > FRAGILE_RELOCATE_RATE_THRESHOLD)
      return `tier-3 locator relocating ${(rate * 100).toFixed(0)}% of runs (> ${FRAGILE_RELOCATE_RATE_THRESHOLD * 100}%)`;
  }
  return null;
}

export function isStepDegraded(step: StepHealth): boolean {
  return degradeReason(step) !== null;
}

export function shouldDemote(health: Health | undefined): { demote: boolean; reasons: { step: string; reason: string }[] } {
  const reasons: { step: string; reason: string }[] = [];
  if (health) {
    for (const [step, h] of Object.entries(health.steps)) {
      const r = degradeReason(h);
      if (r) reasons.push({ step, reason: r });
    }
  }
  return { demote: reasons.length > 0, reasons };
}

/**
 * 0–100 health score for the Hub UI (Forge-specific, not a BrowserOps concept).
 * Starts from locator tier quality and subtracts drift signals.
 */
export function healthScore(health: Health | undefined): number | null {
  if (!health) return null;
  const steps = Object.values(health.steps);
  if (steps.length === 0) return null;
  let total = 0;
  for (const s of steps) {
    const base = s.last_tier === 1 ? 100 : s.last_tier === 2 ? 88 : 70;
    const relocRate = s.runs ? s.relocates / s.runs : 0;
    const ambRate = s.runs ? s.ambiguous_resolves / s.runs : 0;
    let score = base - relocRate * 60 - ambRate * 25 - Math.min(s.target_changed, 3) * 10;
    if (isStepDegraded(s)) score = Math.min(score, 45);
    total += Math.max(0, score);
  }
  return Math.round(total / steps.length);
}
