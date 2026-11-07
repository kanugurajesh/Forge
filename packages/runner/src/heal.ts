import type { Page } from "playwright";
import { classifyLocator, describeLocator, hardenForForbidden, proposeLocator, type Locator, type Procedure } from "@forge/core";
import { executeProcedure, type RunResult } from "./execute.ts";

export interface HealPatch {
  step: string;
  before: Locator;
  after: Locator;
  tier_before: number | null;
  tier_after: number;
  why: string;
}

/**
 * Self-heal: replay the procedure against the live page, and for every step
 * that had to relocate (or is named in `steps`) re-propose the smallest
 * highest-tier locator from the live snapshot. The result is a new procedure
 * version that starts as a draft and has to re-earn trust.
 */
export async function healProcedure(
  page: Page,
  proc: Procedure,
  inputs: Record<string, unknown>,
  steps: string[] = [],
): Promise<{ procedure: Procedure; patches: HealPatch[]; run: RunResult }> {
  const patches: HealPatch[] = [];
  const next: Procedure = structuredClone(proc);
  const want = new Set(steps);

  const run = await executeProcedure(page, proc, {
    inputs,
    onResolved(stepId, target, snapshot, relocated) {
      if (!relocated && !want.has(stepId)) return;
      const step = next.steps.find((s) => s.id === stepId);
      if (!step?.locator) return;
      const p = proposeLocator(target, snapshot);
      hardenForForbidden(p.locator, target, proc.forbidden?.locators ?? []);
      if (JSON.stringify(p.locator) === JSON.stringify(step.locator)) return;
      patches.push({
        step: stepId,
        before: step.locator,
        after: p.locator,
        tier_before: classifyLocator(step.locator),
        tier_after: p.tier,
        why: relocated ? `relocated to ${target.role} "${target.name}" — re-proposed ${describeLocator(p.locator)}` : "requested",
      });
      step.locator = p.locator;
      if (step.goal && target.name) step.goal = step.goal.replace(/"[^"]*"/, `"${target.name}"`);
      // Keep any wait step that guarded the same control in sync.
      for (const s of next.steps) if (s.do === "wait" && JSON.stringify(s.locator) === JSON.stringify(patches.at(-1)!.before)) s.locator = p.locator;
      if (p.tier === 1 && step.fallback?.strategy !== "strict") step.fallback = { strategy: "retry", retry: { attempts: 2, backoff_ms: 250 } };
    },
  });

  next.meta = {
    version: (proc.meta?.version ?? 1) + 1,
    created: proc.meta?.created ?? new Date().toISOString(),
    status: "draft",
  };
  return { procedure: next, patches, run };
}
