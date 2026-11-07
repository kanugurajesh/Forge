import { stringify } from "yaml";
import type { Expect, Fallback, InputSpec, Locator, Procedure, SideEffect, Step } from "./types.ts";
import {
  MUTATING_TOOLS,
  NAV_TOOLS,
  OBSERVATION_TOOLS,
  estimateTokens,
  hadPageEffect,
  type SnapshotNode,
  type ToolCall,
  type ToolResult,
  type Trajectory,
} from "./trajectory.ts";
import { proposeLocator } from "./resolve.ts";
import { anchoredName, escapeRegex, type Tier } from "./locator.ts";
import { validateProcedure, type SchemaIssue } from "./schema.ts";
import { lintProcedure, type LintFinding } from "./lint.ts";

export type DropReason =
  | "observation"
  | "failed"
  | "no_page_effect"
  | "superseded"
  | "redundant_navigation"
  | "unreplayable";

export interface CompileEvent {
  seq: number;
  tool: string;
  decision: "kept" | "dropped";
  reason?: DropReason;
  detail: string;
  step_id?: string;
  tokens: number;
}

export interface CompileOptions {
  name?: string;
  description?: string;
  app?: string;
  now?: string;
}

export interface CompileResult {
  procedure: Procedure;
  yaml: string;
  events: CompileEvent[];
  /** Sample values observed for each lifted input (kept OUT of the procedure). */
  samples: Record<string, string>;
  tiers: Record<"1" | "2" | "3", number>;
  stats: {
    recorded_calls: number;
    kept_steps: number;
    dropped: Record<DropReason, number>;
    recorded_tokens: number;
    recorded_ms: number;
    replay_tool_calls: number;
    replay_llm_tokens: number;
  };
  warnings: string[];
  schema: { valid: boolean; issues: SchemaIssue[] };
  lint: LintFinding[];
}

const DESTRUCTIVE_CONTROL = /^(delete|discard|remove|trash|archive|unsubscribe|deactivate|close account|cancel (plan|subscription)|leave|revoke|reset)\b/i;
const SEND_CONTROL = /^(send|reply|post|submit|comment|publish|share|invite)\b/i;
const STATIC_ASSET = /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|map)(\?|$)/i;

interface Draft {
  step: Step;
  seq: number;
  node?: SnapshotNode;
  tier?: Tier;
  endpoints: string[];
  inputName?: string;
}

function slug(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, max)
      .replace(/_+$/, "") || "step"
  );
}

function appFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) {
      const seg = u.pathname.split("/").filter(Boolean)[0];
      return seg ? slug(seg, 20) : "local";
    }
    const parts = u.hostname.replace(/^www\./, "").split(".");
    return slug(parts.length > 2 ? parts[parts.length - 2] : parts[0], 20);
  } catch {
    return undefined;
  }
}

function pathOf(endpoint: string): string {
  try {
    const u = new URL(endpoint, "http://x");
    return u.pathname;
  } catch {
    return endpoint;
  }
}

function endpointsOf(r: ToolResult | undefined): string[] {
  const eps = r?.effect?.network?.endpoints ?? [];
  return eps.filter((e) => !STATIC_ASSET.test(e));
}

function urlPattern(url: string): string {
  try {
    const u = new URL(url);
    return escapeRegex(u.pathname + (u.hash ? u.hash : ""));
  } catch {
    return escapeRegex(url);
  }
}

function deriveExpect(r: ToolResult | undefined, node: SnapshotNode | undefined): Expect | undefined {
  const dialogs = r?.effect?.new_dialogs ?? [];
  if (dialogs.length > 0) {
    return { new_dialog: dialogs[0].name ? anchoredName(dialogs[0].name) : true, timeout_ms: 5000 };
  }
  const pe = r?.page_effect;
  if (pe?.url?.changed && pe.url.after) return { url_matches: urlPattern(pe.url.after), timeout_ms: 5000 };
  const eps = endpointsOf(r);
  if (eps.length > 0) return { network_endpoint_seen: pathOf(eps[eps.length - 1]), timeout_ms: 8000 };
  const removed = pe?.dom?.removed ?? r?.effect?.mutations?.removed ?? 0;
  if (node?.dialog && removed > 0) return { dom_removed_min: 1, timeout_ms: 5000 };
  const added = pe?.dom?.added ?? r?.effect?.mutations?.added ?? 0;
  if (added > 0) return { dom_added_min: 1, timeout_ms: 5000 };
  return undefined;
}

function fallbackFor(tier: Tier, hasExpect: boolean): Fallback {
  if (tier === 1) return { strategy: "retry", retry: { attempts: 2, backoff_ms: 250 } };
  // Tier 2/3: copy-derived — let the runtime widen, then (only with a positive predicate) ask an LLM.
  return {
    strategy: hasExpect ? "relocate_then_llm" : "relocate",
    relocate: { widen_name: true, consider_text: true },
    budget: { tool_calls: 4, tokens: 4000 },
  };
}

function inputNameFor(node: SnapshotNode): string {
  const a = node.attrs ?? {};
  const label = a.name || node.name || a["aria-label"] || a.placeholder || "text";
  let n = slug(label, 30);
  if (!/^[a-z]/.test(n)) n = `field_${n}`;
  return n;
}

function verbFor(tool: string): Step["do"] | undefined {
  switch (tool) {
    case "browser_click":
    case "browser_click_by_text":
      return "click";
    case "browser_type":
    case "browser_find_and_replace":
      return "type";
    case "browser_press":
      return "press";
    case "browser_hover":
      return "hover";
    case "browser_scroll":
      return "scroll";
    default:
      return undefined;
  }
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let i = 2;
  while (used.has(id)) id = `${base}_${i++}`;
  used.add(id);
  return id;
}

export function compileTrajectory(traj: Trajectory, opts: CompileOptions = {}): CompileResult {
  const events: CompileEvent[] = [];
  const drafts: Draft[] = [];
  const warnings: string[] = [];
  const samples: Record<string, string> = {};
  const inputs: Record<string, InputSpec & { _node?: SnapshotNode }> = {};
  const seen = new Map<number | string, SnapshotNode>();
  const ids = new Set<string>();
  let snapshot: SnapshotNode[] = [];
  let firstUrl: string | undefined;
  let lastMutatingSeq = -1;

  const drop = (c: ToolCall, reason: DropReason, detail: string) =>
    events.push({ seq: c.seq, tool: c.tool, decision: "dropped", reason, detail, tokens: estimateTokens(c) });
  const keep = (c: ToolCall, d: Draft, detail: string) => {
    drafts.push(d);
    events.push({ seq: c.seq, tool: c.tool, decision: "kept", detail, step_id: d.step.id, tokens: estimateTokens(c) });
  };

  for (const call of traj.calls) {
    const r = call.result;
    const preSnapshot = snapshot;
    if (r?.snapshot && r.snapshot.length > 0) {
      snapshot = r.snapshot;
      for (const n of r.snapshot) seen.set(`${n.role}|${n.name}|${n.dialog ?? ""}`, n);
    }

    if (OBSERVATION_TOOLS.has(call.tool) || call.tool.startsWith("lore_") || call.tool.startsWith("procedures_")) {
      drop(call, "observation", "read-only; the runtime auto-primes before locator steps");
      continue;
    }
    const failed = r?.ok === false || typeof r?.error === "string";

    if (NAV_TOOLS.has(call.tool)) {
      if (failed) {
        drop(call, "failed", `navigation failed: ${r?.error ?? "error"}`);
        continue;
      }
      if (call.tool !== "browser_navigate") {
        drop(call, "unreplayable", `${call.tool} depends on history; the next navigate pins the URL explicitly`);
        continue;
      }
      const url = String(call.args.url ?? "");
      firstUrl ??= url;
      const finalUrl = r?.page_effect?.url?.after ?? (typeof r?.url === "string" ? r.url : url);
      const prev = drafts[drafts.length - 1];
      if (prev?.step.do === "navigate") {
        drafts.pop();
        ids.delete(prev.step.id);
        const ev = events.find((e) => e.step_id === prev.step.id);
        if (ev) Object.assign(ev, { decision: "dropped", reason: "redundant_navigation", detail: "superseded by the next navigation", step_id: undefined });
      }
      const step: Step = {
        id: uniqueId("open_app", ids),
        goal: `Open ${url}`,
        do: "navigate",
        with: { url },
        expect: { url_matches: urlPattern(finalUrl), timeout_ms: 10000 },
      };
      keep(call, { step, seq: call.seq, endpoints: [] }, `navigate → ${url}`);
      continue;
    }

    if (!MUTATING_TOOLS.has(call.tool)) {
      drop(call, "unreplayable", `unknown tool ${call.tool}`);
      continue;
    }
    if (failed) {
      drop(call, "failed", `tool error: ${String(r?.error ?? "ok:false").slice(0, 120)}`);
      continue;
    }
    if (call.tool === "browser_execute_js") {
      drop(call, "unreplayable", "raw JS is always risky — re-author as a locator step");
      warnings.push(`seq ${call.seq}: execute_js dropped; check the procedure still reaches the goal`);
      continue;
    }
    if (call.tool === "browser_click_at") {
      drop(call, "unreplayable", "coordinate clicks don't survive layout changes");
      warnings.push(`seq ${call.seq}: coordinate click dropped; add a semantic target for it`);
      continue;
    }
    if (!hadPageEffect(r)) {
      drop(call, "no_page_effect", "dispatched but the page didn't react (page_effect = 0)");
      continue;
    }

    const verb = verbFor(call.tool)!;
    let node: SnapshotNode | undefined;
    if (typeof call.args.ref === "number" || typeof call.args.ref === "string") {
      const ref = Number(call.args.ref);
      node = preSnapshot.find((n) => n.ref === ref);
    } else if (call.tool === "browser_click_by_text") {
      const t = String(call.args.text ?? "").toLowerCase();
      node = preSnapshot.find((n) => n.name.toLowerCase() === t) ?? preSnapshot.find((n) => n.name.toLowerCase().includes(t));
    }

    const needsTarget = verb !== "press" && verb !== "scroll";
    if (needsTarget && !node) {
      drop(call, "unreplayable", `ref ${String(call.args.ref ?? call.args.text)} not found in the preceding snapshot`);
      warnings.push(`seq ${call.seq}: could not map target to a semantic locator`);
      continue;
    }

    let locator: Locator | undefined;
    let tier: Tier | undefined;
    if (node) {
      const p = proposeLocator(node, preSnapshot);
      locator = p.locator;
      tier = p.tier;
      for (const w of p.warnings) warnings.push(`${node.role} "${node.name}": ${w}`);
    }

    const label = node?.name || node?.attrs?.["aria-label"] || String(call.args.key ?? verb);
    const step: Step = { id: "", goal: "", do: verb };
    if (locator) step.locator = locator;
    let inputName: string | undefined;

    if (verb === "type") {
      inputName = node ? inputNameFor(node) : "text";
      const prevDraft = drafts[drafts.length - 1];
      // Retyping the same field supersedes the earlier attempt.
      if (prevDraft?.step.do === "type" && prevDraft.node?.ref === node?.ref) {
        drafts.pop();
        ids.delete(prevDraft.step.id);
        const ev = events.find((e) => e.step_id === prevDraft.step.id);
        if (ev) Object.assign(ev, { decision: "dropped", reason: "superseded", detail: "field was retyped later", step_id: undefined });
      }
      const value = String(call.args.text ?? "");
      if (inputs[inputName] && samples[inputName] !== value && inputs[inputName]._node?.ref !== node?.ref) {
        inputName = uniqueId(inputName, new Set(Object.keys(inputs)));
      }
      inputs[inputName] = { type: "string", required: true, description: `Text for "${label}"`, _node: node };
      samples[inputName] = value;
      step.with = { text: `{{${inputName}}}`, clear_mode: "auto" };
      step.goal = `Type ${inputName} into "${label}"`;
      step.id = uniqueId(`fill_${slug(label, 30)}`, ids);
    } else if (verb === "press") {
      step.with = { key: call.args.key, ...(call.args.modifiers ? { modifiers: call.args.modifiers } : {}) };
      step.goal = `Press ${String(call.args.key)}`;
      step.id = uniqueId(`press_${slug(String(call.args.key ?? "key"), 20)}`, ids);
    } else if (verb === "scroll") {
      const { tab_id: _t, ...rest } = call.args;
      step.with = rest;
      step.goal = "Scroll";
      step.id = uniqueId("scroll", ids);
    } else {
      step.goal = `${verb === "hover" ? "Hover" : "Click"} "${label}"`;
      step.id = uniqueId(`${verb}_${slug(label, 30)}`, ids);
    }

    if (verb !== "type") {
      const expect = deriveExpect(r, node);
      if (expect) step.expect = expect;
    }
    if (tier && verb !== "press") step.fallback = fallbackFor(tier, !!step.expect);

    lastMutatingSeq = call.seq;
    keep(call, { step, seq: call.seq, node, tier, endpoints: endpointsOf(r), inputName }, step.goal ?? "");
  }

  // ---- entry-step pattern: navigate → wait for entry control → act
  const navIdx = drafts.findIndex((d) => d.step.do === "navigate");
  if (navIdx >= 0) {
    const entry = drafts[navIdx + 1];
    if (entry?.step.locator && entry.step.do === "click") {
      drafts.splice(navIdx + 1, 0, {
        step: {
          id: uniqueId(`wait_${slug(entry.node?.name ?? "entry", 30)}`, ids),
          goal: `Wait until "${entry.node?.name ?? "entry control"}" is ready`,
          do: "wait",
          locator: entry.step.locator,
          with: { timeout_ms: 10000 },
        },
        seq: entry.seq,
        endpoints: [],
      });
    }
  }

  // ---- side effects, destructive inputs, forbidden controls
  const actionDrafts = drafts.filter((d) => d.step.do === "click");
  const sideEffects = new Set<SideEffect>();
  let submit: Draft | undefined;
  for (const d of actionDrafts) {
    const nm = d.node?.name ?? "";
    const eps = d.endpoints.join(" ");
    if (SEND_CONTROL.test(nm) || /send|message|comment|reply/i.test(eps)) {
      sideEffects.add(/post|publish|share/i.test(nm) ? "post_public" : "send_message");
      submit = d;
    }
    if (/^(pay|checkout|purchase|buy)\b/i.test(nm)) sideEffects.add("payment");
    if (DESTRUCTIVE_CONTROL.test(nm)) sideEffects.add("delete");
  }
  if (submit) {
    for (const [name, spec] of Object.entries(inputs)) {
      if ((spec._node?.dialog ?? "") === (submit.node?.dialog ?? "")) spec.destructive = true;
    }
  }

  const targetRefs = new Set(drafts.map((d) => `${d.node?.role}|${d.node?.name}`));
  const forbidden: Locator[] = [];
  const forbiddenNames = new Set<string>();
  for (const n of seen.values()) {
    if (!["button", "link", "menuitem"].includes(n.role)) continue;
    if (!DESTRUCTIVE_CONTROL.test(n.name) || targetRefs.has(`${n.role}|${n.name}`)) continue;
    const key = n.name.toLowerCase();
    if (forbiddenNames.has(key) || forbidden.length >= 10) continue;
    forbiddenNames.add(key);
    forbidden.push({ role: n.role, name: anchoredName(n.name) });
  }

  // ---- verify: endpoint of the final submit + any status/alert text that appeared after it
  const verify: Expect = {};
  const last = [...drafts].reverse().find((d) => d.step.do !== "navigate" && d.step.do !== "wait" && d.endpoints.length > 0);
  if (last && last.endpoints.length) verify.network_endpoint_seen = pathOf(last.endpoints[last.endpoints.length - 1]);
  const before = new Set<string>();
  for (const c of traj.calls) {
    if (c.seq < lastMutatingSeq && c.result?.snapshot) for (const n of c.result.snapshot) before.add(`${n.role}|${n.name}`);
  }
  const after = traj.calls.find((c) => c.seq > lastMutatingSeq && c.result?.snapshot?.length);
  const status = after?.result?.snapshot?.find(
    (n) => (n.role === "status" || n.role === "alert") && n.name && !before.has(`${n.role}|${n.name}`),
  );
  if (status) {
    let text = status.name;
    for (const [k, v] of Object.entries(samples)) if (v && text.includes(v)) text = text.split(v)[0].trim() || `{{${k}}}`;
    verify.text_visible = text;
  }
  if (Object.keys(verify).length) verify.timeout_ms = 8000;

  // ---- assemble
  const app = slug(opts.app ?? traj.app ?? appFromUrl(firstUrl) ?? "app", 20).replace(/^[^a-z]+/, "") || "app";
  const task = traj.task ?? "";
  const intent = slug(intentWords(task, app).join(" "), 32) || "flow";
  const name = opts.name ?? `${app}.${intent}`;
  const cleanInputs: Record<string, InputSpec> = {};
  for (const [k, { _node, ...spec }] of Object.entries(inputs)) cleanInputs[k] = spec;

  const procedure: Procedure = {
    schema_version: 1,
    name,
    description: (opts.description ?? (task || `Compiled from ${traj.calls.length} recorded tool calls`)).slice(0, 200),
    kind: "leaf",
    ...(task ? { goal: task.slice(0, 200) } : {}),
    domain: app,
    ...(task ? { triggers: [task.slice(0, 80)] } : {}),
    tags: [app, "forge-compiled"],
    ...(sideEffects.size ? { side_effects: [...sideEffects] } : {}),
    ...(Object.keys(cleanInputs).length ? { inputs: cleanInputs } : {}),
    ...(forbidden.length ? { forbidden: { locators: forbidden } } : {}),
    ...(Object.keys(verify).length ? { verify } : {}),
    steps: drafts.map((d) => d.step),
    meta: { version: 1, created: opts.now ?? new Date().toISOString(), status: "draft" },
  };

  const dropped: Record<DropReason, number> = {
    observation: 0,
    failed: 0,
    no_page_effect: 0,
    superseded: 0,
    redundant_navigation: 0,
    unreplayable: 0,
  };
  for (const e of events) if (e.decision === "dropped" && e.reason) dropped[e.reason]++;
  const tiers = { "1": 0, "2": 0, "3": 0 } as Record<"1" | "2" | "3", number>;
  for (const d of drafts) if (d.tier && d.step.do !== "wait") tiers[String(d.tier) as "1" | "2" | "3"]++;

  const recordedMs = (() => {
    const withDur = traj.calls.reduce((s, c) => s + (c.duration_ms ?? 0), 0);
    if (withDur > 0) return withDur;
    const ts = traj.calls.map((c) => (c.ts ? Date.parse(c.ts) : NaN)).filter((n) => !Number.isNaN(n));
    return ts.length > 1 ? Math.max(...ts) - Math.min(...ts) : 0;
  })();

  const schema = validateProcedure(procedure);
  return {
    procedure,
    yaml: toYaml(procedure),
    events: events.sort((a, b) => a.seq - b.seq),
    samples,
    tiers,
    stats: {
      recorded_calls: traj.calls.length,
      kept_steps: procedure.steps.length,
      dropped,
      recorded_tokens: traj.calls.reduce((s, c) => s + estimateTokens(c), 0),
      recorded_ms: recordedMs,
      replay_tool_calls: procedure.steps.length,
      replay_llm_tokens: 0,
    },
    warnings: [...new Set(warnings)],
    schema,
    lint: lintProcedure(procedure),
  };
}

/**
 * Task words minus filler and the app's own name — whether written as one
 * word ("Relay") or as adjacent words that spell it ("Acme Mail" → acmemail).
 * Words merely *contained* in the app name ("email" in "acmemail") are kept.
 */
export function intentWords(task: string, app: string): string[] {
  const words = task.split(/\s+/).map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean);
  const drop = new Set<number>();
  for (let i = 0; i < words.length; i++) {
    let joined = "";
    for (let j = i; j < words.length && joined.length < app.length; j++) {
      joined += words[j];
      if (joined === app) for (let k = i; k <= j; k++) drop.add(k);
    }
  }
  return words.filter((w, i) => !drop.has(i) && !/^(in|on|the|a|an|to|my|with|and|using|via|for)$/.test(w));
}

export function toYaml(p: Procedure): string {
  return stringify(p, { lineWidth: 0, aliasDuplicateObjects: false });
}
