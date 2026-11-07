import type { Procedure, Step } from "./types.ts";
import { classifyLocator, forbiddenOverlaps, parseSerialisedRegex } from "./locator.ts";
import { validateProcedure } from "./schema.ts";

/**
 * Procedure linter. Each rule encodes a failure mode documented in BrowserOps'
 * `browserops-teach` skill ("Don'ts") or the procedures docs, so authors catch
 * it before a strict run does.
 */

export type Severity = "error" | "warning" | "info";

export interface LintFinding {
  rule: string;
  severity: Severity;
  step?: string;
  message: string;
  fix?: string;
}

export const RULES: Record<string, { severity: Severity; title: string }> = {
  "schema": { severity: "error", title: "Must satisfy the BrowserOps v1 procedure schema" },
  "no-baked-ref": { severity: "error", title: "Refs don't survive replay — use a locator" },
  "llm-needs-expect": { severity: "error", title: "llm fallback without expect fires on every step" },
  "undeclared-input": { severity: "error", title: "Template references an input that isn't declared" },
  "forbidden-collision": { severity: "error", title: "BrowserOps' static forbidden guard will refuse this step" },
  "unused-input": { severity: "warning", title: "Declared input is never used" },
  "fragile-locator": { severity: "warning", title: "Tier-3 (nth) locator without a recovery path" },
  "unanchored-name": { severity: "warning", title: "Unanchored name matches more than you think" },
  "missing-forbidden": { severity: "warning", title: "Side effects declared but no forbidden block" },
  "destructive-input": { severity: "warning", title: "Input feeds a side-effecting flow but isn't marked destructive" },
  "manual-prime": { severity: "warning", title: "Manual observe right before a locator step is redundant" },
  "missing-verify": { severity: "warning", title: "No top-level verify — completed:true can't be trusted" },
  "raw-js": { severity: "warning", title: "js steps are always risky" },
  "hardcoded-identity": { severity: "warning", title: "Hardcoded email/handle in a locator — lift it to an input" },
  "click-without-expect": { severity: "info", title: "Click has no expect predicate" },
  "tier-2-locator": { severity: "info", title: "Copy-derived locator (tier 2)" },
};

const TEMPLATE = /\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g;

function templatesIn(v: unknown, out: Set<string>) {
  if (typeof v === "string") for (const m of v.matchAll(TEMPLATE)) out.add(m[1]);
  else if (Array.isArray(v)) v.forEach((x) => templatesIn(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => templatesIn(x, out));
}

const BUILTIN_TEMPLATES = new Set(["tab_id"]);

export function lintProcedure(p: Procedure): LintFinding[] {
  const f: LintFinding[] = [];
  const add = (rule: string, message: string, step?: string, fix?: string) =>
    f.push({ rule, severity: RULES[rule].severity, message, step, fix });

  const schema = validateProcedure(p);
  for (const issue of schema.issues) add("schema", `${issue.path}: ${issue.message}`);

  const steps: Step[] = Array.isArray(p.steps) ? p.steps : [];
  const used = new Set<string>();
  templatesIn(steps, used);
  templatesIn(p.verify, used);
  const declared = new Set(Object.keys(p.inputs ?? {}));
  for (const name of used) {
    if (!declared.has(name) && !BUILTIN_TEMPLATES.has(name))
      add("undeclared-input", `{{${name}}} is used but not declared in inputs`, undefined, `Add inputs.${name}: { type: string }`);
  }
  for (const name of declared) if (!used.has(name)) add("unused-input", `inputs.${name} is never referenced`);

  steps.forEach((s, i) => {
    if (s.with && "ref" in s.with) add("no-baked-ref", "step bakes a numeric ref", s.id, "Replace with a locator from browser_propose_locator");
    const strategy = s.fallback?.strategy;
    if ((strategy === "llm" || strategy === "relocate_then_llm") && !s.expect)
      add("llm-needs-expect", `fallback.strategy=${strategy} but no expect block`, s.id, "Add an effect-based expect (new_dialog, network_endpoint_seen, dom_added_min)");
    const tier = classifyLocator(s.locator);
    if (tier === 3 && strategy !== "relocate_then_llm" && strategy !== "llm")
      add("fragile-locator", "nth-based locator with no relocate_then_llm fallback", s.id, "Inject a data-testid, or set fallback.strategy: relocate_then_llm");
    if (tier === 2) add("tier-2-locator", "locator depends on visible copy", s.id);
    const name = s.locator?.name;
    if (name && !parseSerialisedRegex(name) && ["button", "link", "menuitem", undefined].includes(s.locator?.role))
      add("unanchored-name", `name "${name}" also matches e.g. "Schedule ${name}" / "Re${name}"`, s.id, `Use name: "/^${name}$/i"`);
    for (const v of [s.locator?.name, s.locator?.has_text, s.locator?.aria_label]) {
      if (v && /[\w.+-]+@[\w-]+\.[\w.]+|^@\w+/.test(v)) add("hardcoded-identity", `locator contains "${v}"`, s.id, "Lift the identity into an input");
    }
    if (s.do === "observe" && steps[i + 1]?.locator) add("manual-prime", "the executor auto-primes before every locator step", s.id, "Delete this step");
    if (s.do === "js") add("raw-js", "js steps bypass locator safety", s.id);
    if (s.do === "click" && !s.expect) add("click-without-expect", "add an expect so drift is detected", s.id);
    if (s.locator) {
      const hit = (p.forbidden?.locators ?? []).find((d) => forbiddenOverlaps(d, s.locator!));
      if (hit)
        add(
          "forbidden-collision",
          `locator can't be proven distinct from forbidden ${JSON.stringify(hit)} (the runtime compares only role + name)`,
          s.id,
          "Add the target's role, and an anchored name if the role matches",
        );
    }
  });

  const se = p.side_effects ?? [];
  if (se.length > 0 && !(p.forbidden?.locators?.length || p.forbidden?.actions?.length))
    add("missing-forbidden", `side_effects [${se.join(", ")}] declared with no forbidden{} guard`, undefined, 'Add forbidden.locators: [{ role: "button", name: "/^delete/i" }]');
  if (se.some((x) => x !== "delete")) {
    for (const [k, spec] of Object.entries(p.inputs ?? {})) {
      if (!spec.destructive && used.has(k)) add("destructive-input", `inputs.${k} reaches a ${se.join("/")} flow`, undefined, `Set inputs.${k}.destructive: true`);
    }
  }
  if (!p.verify || Object.keys(p.verify).filter((k) => k !== "timeout_ms" && k !== "poll_interval_ms").length === 0)
    add("missing-verify", "no top-level verify{} block", undefined, 'Add verify: { text_visible: "Sent" } or network_endpoint_seen');

  const order = { error: 0, warning: 1, info: 2 } as const;
  return f.sort((a, b) => order[a.severity] - order[b.severity]);
}

export function lintSummary(f: LintFinding[]) {
  return {
    errors: f.filter((x) => x.severity === "error").length,
    warnings: f.filter((x) => x.severity === "warning").length,
    infos: f.filter((x) => x.severity === "info").length,
  };
}
