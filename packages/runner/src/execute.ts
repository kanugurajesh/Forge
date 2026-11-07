import type { Page } from "playwright";
import {
  classifyLocator,
  nodeMatches,
  parseSerialisedRegex,
  resolveLocator,
  textMatches,
  type Expect,
  type Locator,
  type Procedure,
  type ResolutionRecord,
  type SnapshotNode,
  type Step,
  type Tier,
} from "@forge/core";
import { snapshotPage, refSelector } from "./snapshot.ts";
import { measure, type Measured } from "./effects.ts";

/**
 * Deterministic procedure executor. Zero LLM calls on the happy path:
 *   auto-prime snapshot → resolve locator → forbidden check → dispatch →
 *   poll expect → record resolution for drift health.
 * Fallback ladder per step: strict | retry | relocate | relocate_then_llm | llm.
 * An LLM rung halts with status "needs_llm"; in BrowserOps that's where
 * procedures_resume takes an agent patch.
 */

export interface StepOutcome {
  id: string;
  do: Step["do"];
  ok: boolean;
  ms: number;
  tier?: Tier;
  match_count?: number;
  matched_ref?: number;
  matched_name?: string;
  relocated?: boolean;
  relocated_to?: string;
  expect_met?: boolean;
  error?: string;
}

export interface RunResult {
  procedure: string;
  completed: boolean;
  status: "completed" | "halted" | "needs_llm" | "forbidden";
  strict: boolean;
  used_llm_fallback: boolean;
  duration_ms: number;
  steps: StepOutcome[];
  resolutions: Record<string, ResolutionRecord>;
  verify_ok?: boolean;
  divergence?: { step: string; reason: string };
}

export interface ExecuteOptions {
  inputs?: Record<string, unknown>;
  strict?: boolean;
  log?: (line: string) => void;
  /** Called after each locator step resolves, with the live snapshot (used by heal). */
  onResolved?: (stepId: string, target: SnapshotNode, snapshot: SnapshotNode[], relocated: boolean) => void;
}

const TEMPLATE = /\{\{\s*([a-zA-Z_]\w*)\s*\}\}/g;

function render<T>(v: T, inputs: Record<string, unknown>): T {
  if (typeof v === "string") {
    const whole = /^\{\{\s*([a-zA-Z_]\w*)\s*\}\}$/.exec(v);
    if (whole && whole[1] in inputs) return inputs[whole[1]] as T;
    return v.replace(TEMPLATE, (m, k) => (k in inputs ? String(inputs[k]) : m)) as T;
  }
  if (Array.isArray(v)) return v.map((x) => render(x, inputs)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, render(x, inputs)])) as T;
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function similarity(a: string, b: string): number {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (y.startsWith(x) || x.startsWith(y)) return 0.85 - Math.abs(x.length - y.length) / 200;
  const wa = new Set(x.split(/\W+/).filter(Boolean));
  const wb = new Set(y.split(/\W+/).filter(Boolean));
  const inter = [...wa].filter((w) => wb.has(w)).length;
  return inter / Math.max(wa.size, wb.size, 1) * 0.6;
}

/** Widen a locator that no longer resolves, then rank candidates by similarity to the original target. */
function relocate(snapshot: SnapshotNode[], loc: Locator, opts: { widen_name?: boolean; widen_role?: boolean; consider_text?: boolean } = {}) {
  const original = parseSerialisedRegex(loc.name)?.source.replace(/^\^|\$$/g, "").replace(/\\(.)/g, "$1") ?? loc.name ?? "";
  const widened: Locator = { ...loc };
  if (opts.widen_name !== false) delete widened.name;
  if (opts.widen_role) delete widened.role;
  delete widened.nth;
  let pool = resolveLocator(snapshot, widened);
  const score = (n: SnapshotNode) => Math.max(similarity(original, n.name), opts.consider_text && n.text ? similarity(original, n.text) : 0);
  const ranked = pool
    .map((n) => ({ n, s: score(n) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s);
  if (ranked.length === 0) return null;
  // Ambiguous if the runner-up is nearly as good.
  if (ranked[1] && ranked[0].s - ranked[1].s < 0.1) return { node: ranked[0].n, candidates: ranked.length, ambiguous: true };
  return { node: ranked[0].n, candidates: ranked.length, ambiguous: false };
}

async function pollExpect(page: Page, exp: Expect | undefined, m: Measured | undefined, liveEndpoints: string[]): Promise<{ ok: boolean; reason?: string }> {
  if (!exp) return { ok: true };
  const timeout = exp.timeout_ms ?? 5000;
  const interval = exp.poll_interval_ms ?? 100;
  const deadline = Date.now() + timeout;
  let reason = "";
  while (true) {
    reason = "";
    if (exp.url_matches && !new RegExp(exp.url_matches).test(page.url())) reason = `url ${page.url()} !~ ${exp.url_matches}`;
    if (!reason && exp.new_dialog !== undefined) {
      const fromEffect = m?.effect.new_dialogs ?? [];
      const open: string[] = await page.$$eval("dialog[open],[role=dialog]", (ds) => ds.map((d) => d.getAttribute("aria-label") ?? ""));
      const names = [...fromEffect.map((d) => d.name), ...open];
      const ok = exp.new_dialog === true ? names.length > 0 : exp.new_dialog === false ? names.length === 0 : names.some((n) => textMatches(String(exp.new_dialog), n));
      if (!ok) reason = `no new dialog matched ${String(exp.new_dialog)}`;
    }
    for (const key of ["network_endpoint_seen", "network_endpoint"] as const) {
      const ep = exp[key];
      if (!reason && ep && !liveEndpoints.some((e) => e.includes(ep))) reason = `endpoint ${ep} not seen`;
    }
    if (!reason && (exp.text_visible || exp.text_invisible)) {
      const body = await page.evaluate(() => document.body.innerText);
      if (exp.text_visible && !textMatches(exp.text_visible, body)) reason = `text "${exp.text_visible}" not visible`;
      if (exp.text_invisible && textMatches(exp.text_invisible, body)) reason = `text "${exp.text_invisible}" still visible`;
    }
    if (!reason && exp.dom_added_min !== undefined && (m?.page_effect.dom.added ?? 0) < exp.dom_added_min) reason = `dom_added < ${exp.dom_added_min}`;
    if (!reason && exp.dom_removed_min !== undefined && (m?.page_effect.dom.removed ?? 0) < exp.dom_removed_min) reason = `dom_removed < ${exp.dom_removed_min}`;
    if (!reason) return { ok: true };
    if (Date.now() >= deadline) return { ok: false, reason };
    await sleep(interval);
  }
}

export async function executeProcedure(page: Page, proc: Procedure, opts: ExecuteOptions = {}): Promise<RunResult> {
  const inputs = { tab_id: 1, ...(opts.inputs ?? {}) };
  const strict = opts.strict ?? false;
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  const steps: StepOutcome[] = [];
  const resolutions: Record<string, ResolutionRecord> = {};
  const liveEndpoints: string[] = [];
  const runEndpoints: string[] = [];
  const onReq = (r: { url(): string; resourceType(): string }) => {
    if (["fetch", "xhr", "document"].includes(r.resourceType())) {
      liveEndpoints.push(r.url());
      runEndpoints.push(r.url());
    }
  };
  page.on("request", onReq);

  for (const [k, spec] of Object.entries(proc.inputs ?? {})) {
    if (spec.required !== false && !(k in inputs)) {
      page.off("request", onReq);
      return { procedure: proc.name, completed: false, status: "halted", strict, used_llm_fallback: false, duration_ms: 0, steps, resolutions, divergence: { step: "-", reason: `missing required input "${k}"` } };
    }
  }

  const finish = (status: RunResult["status"], divergence?: RunResult["divergence"], verify_ok?: boolean): RunResult => {
    page.off("request", onReq);
    return { procedure: proc.name, completed: status === "completed", status, strict, used_llm_fallback: false, duration_ms: Date.now() - t0, steps, resolutions, divergence, verify_ok };
  };

  for (const raw of proc.steps) {
    const step = render(raw, inputs);
    const s0 = Date.now();
    const out: StepOutcome = { id: step.id, do: step.do, ok: false, ms: 0 };
    steps.push(out);
    const fb = step.fallback ?? { strategy: "strict" as const };
    liveEndpoints.length = 0;

    try {
      if (step.do === "navigate") {
        const url = String(step.with?.url ?? "");
        const m = await measure(page, async () => {
          await page.goto(url, { waitUntil: "domcontentloaded" });
        });
        const e = await pollExpect(page, step.expect, m, liveEndpoints);
        out.ok = e.ok;
        out.expect_met = e.ok;
        if (!e.ok) return finish("halted", { step: step.id, reason: e.reason! });
        out.ms = Date.now() - s0;
        log(`  ✓ ${step.id}  ${out.ms}ms`);
        continue;
      }
      if (step.do === "press" && !step.locator) {
        const m = await measure(page, () => page.keyboard.press(String(step.with?.key ?? "Enter")));
        const e = await pollExpect(page, step.expect, m, liveEndpoints);
        out.ok = e.ok;
        if (!e.ok) return finish("halted", { step: step.id, reason: e.reason! });
        out.ms = Date.now() - s0;
        log(`  ✓ ${step.id}  ${out.ms}ms`);
        continue;
      }
      if (!step.locator) return finish("halted", { step: step.id, reason: `step.do=${step.do} without locator is not supported by the Forge runner` });

      // ---- resolve (auto-prime + auto-wait)
      const tier = (classifyLocator(raw.locator) ?? 3) as Tier;
      out.tier = tier;
      const waitMs = step.do === "wait" ? Number(step.with?.timeout_ms ?? 10000) : step.auto_wait?.timeout_ms ?? 3000;
      const attempts = fb.strategy === "retry" ? fb.retry?.attempts ?? 2 : 1;
      let snapshot: SnapshotNode[] = [];
      let matches: SnapshotNode[] = [];
      for (let a = 0; a < attempts && matches.length === 0; a++) {
        if (a > 0) await sleep(fb.retry?.backoff_ms ?? 250);
        const deadline = Date.now() + waitMs;
        while (true) {
          snapshot = await snapshotPage(page);
          matches = resolveLocator(snapshot, step.locator);
          if (matches.length > 0 || Date.now() >= deadline) break;
          await sleep(100);
        }
      }

      let target = matches[0];
      let usedRelocate = false;
      let matchCount = matches.length;
      if (!target) {
        if (fb.strategy === "relocate" || fb.strategy === "relocate_then_llm") {
          const r = relocate(snapshot, step.locator, fb.relocate);
          if (r && !r.ambiguous) {
            target = r.node;
            usedRelocate = true;
            matchCount = 1;
            out.relocated = true;
            out.relocated_to = `${r.node.role} "${r.node.name}"`;
            log(`  ↻ ${step.id}: locator missed, relocated to ${out.relocated_to}`);
          }
        }
        if (!target) {
          if (fb.strategy === "llm" || fb.strategy === "relocate_then_llm") {
            out.error = strict ? "strict mode refuses LLM fallback" : "locator miss — needs an LLM patch (procedures_resume)";
            return finish(strict ? "halted" : "needs_llm", { step: step.id, reason: `locator matched no elements: ${JSON.stringify(step.locator)}` });
          }
          out.error = "locator matched no elements";
          return finish("halted", { step: step.id, reason: `locator matched no elements: ${JSON.stringify(step.locator)}` });
        }
      }

      out.match_count = matchCount;
      out.matched_ref = target.ref;
      out.matched_name = target.name;
      resolutions[step.id] = { match_count: matchCount, used_relocate: usedRelocate, matched_ref: target.ref, tier };
      opts.onResolved?.(step.id, target, snapshot, usedRelocate);

      if (step.do === "wait") {
        out.ok = true;
        out.ms = Date.now() - s0;
        log(`  ✓ ${step.id}  ${out.ms}ms`);
        continue;
      }

      // ---- forbidden: enforced on every dispatch, including relocated targets
      const denied = (proc.forbidden?.locators ?? []).find((f) => nodeMatches(target, f));
      if (denied || proc.forbidden?.actions?.includes(step.do)) {
        out.error = `forbidden: ${denied ? JSON.stringify(denied) : step.do}`;
        return finish("forbidden", { step: step.id, reason: out.error });
      }

      // ---- dispatch + observe
      const el = page.locator(refSelector(target.ref)).first();
      const m = await measure(page, async () => {
        if (step.do === "click") await el.click({ timeout: 3000 });
        else if (step.do === "hover") await el.hover({ timeout: 3000 });
        else if (step.do === "type") await el.fill(String(step.with?.text ?? ""), { timeout: 3000 });
        else if (step.do === "press") {
          await el.focus();
          await page.keyboard.press(String(step.with?.key ?? "Enter"));
        } else if (step.do === "scroll") await el.scrollIntoViewIfNeeded();
        else throw new Error(`unsupported step.do ${step.do}`);
      }, step.do === "type" ? 40 : 150);

      const e = await pollExpect(page, step.expect, m, liveEndpoints);
      out.expect_met = e.ok;
      if (!e.ok) {
        out.error = e.reason;
        return finish(fb.strategy === "llm" || fb.strategy === "relocate_then_llm" ? (strict ? "halted" : "needs_llm") : "halted", { step: step.id, reason: e.reason! });
      }
      out.ok = true;
      out.ms = Date.now() - s0;
      log(`  ✓ ${step.id}  ${out.ms}ms${usedRelocate ? "  (relocated)" : ""}`);
    } catch (err) {
      out.error = (err as Error).message.split("\n")[0];
      return finish("halted", { step: step.id, reason: out.error });
    } finally {
      out.ms ||= Date.now() - s0;
    }
  }

  // ---- top-level verify: the spec of success
  if (proc.verify) {
    const v = render(proc.verify, inputs);
    const e = await pollExpect(page, v, undefined, runEndpoints);
    if (!e.ok) return finish("halted", { step: "verify", reason: e.reason! }, false);
    return finish("completed", undefined, true);
  }
  return finish("completed");
}
