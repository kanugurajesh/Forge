/**
 * A trajectory is one recorded agent run: the ordered browser_* tool calls an
 * agent made while doing a task once, with their results.
 *
 * Result envelopes mirror BrowserOps' tool output:
 *   - `page_effect` (dom / url / focus / network / console_errors / window_ms)
 *   - `effect`      (mutations / network.endpoints / new_dialogs / ...)
 * Snapshots mirror browser_read's a11y tree: nodes addressed by `ref`.
 *
 * Adapters accept:
 *   1. Forge JSONL     — {"type":"meta",...} then {"type":"tool_call",...} lines
 *   2. MCP JSON-RPC    — raw tools/call requests + responses, as any MCP client
 *                        or proxy can capture them (text a11y trees with
 *                        `[ref=N]` / `rN` markers are parsed too)
 */

export interface SnapshotNode {
  ref: number;
  role: string;
  name: string;
  /** Stable attributes: aria-label, data-testid, href, name, id, type, placeholder */
  attrs?: Record<string, string>;
  /** Visible inner text (for has_text) */
  text?: string;
  /** Accessible name of the enclosing dialog, if any */
  dialog?: string;
}

export interface PageEffect {
  dom: { added: number; removed: number; attr_changes: number; text_changes: number };
  url: { changed: boolean; before?: string; after?: string };
  focus: { changed: boolean; before_selector?: string | null; after_selector?: string | null };
  network: { requests_started: number; requests_completed: number; in_flight_at_end: number };
  console_errors: number;
  window_ms: number;
  [k: string]: unknown;
}

export interface Effect {
  url_changed?: boolean;
  mutations?: { added: number; removed: number; attr: number; char: number };
  network?: { requests: number; failed: number; endpoints: string[] };
  new_dialogs?: { role: string; name: string; ref: string }[];
  focus_moved_to?: string | null;
  console_errors?: number;
  [k: string]: unknown;
}

export interface ToolResult {
  ok?: boolean;
  error?: string;
  clicked?: boolean;
  url?: string;
  snapshot?: SnapshotNode[];
  page_effect?: PageEffect;
  effect?: Effect;
  [k: string]: unknown;
}

export interface ToolCall {
  seq: number;
  ts?: string;
  tool: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  usage?: { input_tokens: number; output_tokens: number };
  duration_ms?: number;
}

export interface Trajectory {
  task?: string;
  app?: string;
  started?: string;
  calls: ToolCall[];
}

export const OBSERVATION_TOOLS = new Set([
  "browser_read",
  "browser_observe",
  "browser_quick_read",
  "browser_describe_ref",
  "browser_query_selector",
  "browser_screenshot",
  "browser_list_tabs",
  "browser_current_tab",
  "browser_wait_for",
  "browser_wait_for_idle",
  "browser_locate",
  "browser_propose_locator",
  "browser_set_session_name",
  "browser_switch_tab",
  "browser_new_tab",
  "browser_release_tab",
  "lore_search",
  "lore_get",
  "procedures_search",
  "procedures_get",
]);

export const MUTATING_TOOLS = new Set([
  "browser_click",
  "browser_click_by_text",
  "browser_click_at",
  "browser_type",
  "browser_press",
  "browser_hover",
  "browser_scroll",
  "browser_find_and_replace",
  "browser_execute_js",
]);

export const NAV_TOOLS = new Set(["browser_navigate", "browser_back", "browser_forward", "browser_reload"]);

/** Did the action observably change the page? (the BrowserOps "page effect rule") */
export function hadPageEffect(r: ToolResult | undefined): boolean {
  if (!r) return false;
  const pe = r.page_effect;
  const ef = r.effect;
  if (pe) {
    const d = pe.dom;
    if (d && d.added + d.removed + d.attr_changes + d.text_changes > 0) return true;
    if (pe.url?.changed) return true;
    if (pe.focus?.changed) return true;
    if ((pe.network?.requests_started ?? 0) > 0) return true;
  }
  if (ef) {
    const m = ef.mutations;
    if (m && m.added + m.removed + m.attr + m.char > 0) return true;
    if (ef.url_changed) return true;
    if ((ef.network?.requests ?? 0) > 0) return true;
    if ((ef.new_dialogs?.length ?? 0) > 0) return true;
    // Live BrowserOps: <dialog>.showModal() mutates nothing, but focus lands inside it.
    if (ef.focus_moved_to) return true;
  }
  // Setting an <input>'s value is not a DOM mutation, so a successful type into an
  // already-focused field reports page_effect = 0. `typed` is the dispatch receipt.
  if (typeof r.typed === "number" && r.typed > 0) return true;
  // No envelope at all: we can't prove a no-op, so trust the dispatch.
  return !pe && !ef;
}

/** Rough token estimate when a transcript doesn't carry usage (≈4 chars/token). */
export function estimateTokens(call: ToolCall): number {
  if (call.usage) return call.usage.input_tokens + call.usage.output_tokens;
  const size = JSON.stringify(call.args ?? {}).length + JSON.stringify(call.result ?? {}).length;
  // Every agent turn also re-reads the transcript; 350 tokens is a conservative per-turn reasoning floor.
  return Math.round(size / 4) + 350;
}

// ---------------------------------------------------------------- adapters

/**
 * Parse a text a11y tree into nodes. Accepts `- button "Send" [ref=12]`,
 * `[Send r12]`, and live BrowserOps' `[12] button "Send"` (name optional).
 */
export function parseTextSnapshot(text: string): SnapshotNode[] {
  const nodes: SnapshotNode[] = [];
  const lineRe = /^\s*[-│├└ ]*\s*([a-z]+)\s+"([^"]*)"[^\n]*?\[ref=(?:e)?(\d+)\]/i;
  const leadRe = /^\s*\[(\d+)\]\s+([a-z]+)(?:\s+"([^"]*)")?/i;
  const boxRe = /\[([^\]]*?)\s+r(\d+)\]/;
  for (const line of text.split(/\r?\n/)) {
    const m = lineRe.exec(line);
    if (m) {
      nodes.push({ role: m[1].toLowerCase(), name: m[2], ref: Number(m[3]) });
      continue;
    }
    const l = leadRe.exec(line);
    if (l) {
      nodes.push({ role: l[2].toLowerCase(), name: l[3] ?? "", ref: Number(l[1]) });
      continue;
    }
    const b = boxRe.exec(line);
    if (b) nodes.push({ role: "generic", name: b[1].replace(/^<|>$/g, ""), ref: Number(b[2]) });
  }
  return nodes;
}

/** Attributes live BrowserOps reports that Forge locators can bind to. */
// `type` carries a button's type (submit/button); an <input>'s inputType overrides it below.
const LIVE_ATTRS = ["aria-label", "data-testid", "href", "name", "id", "placeholder", "type"];

/**
 * Live BrowserOps `browser_read` (a11y_tree) returns
 *   { content: "[4] button \"Compose\"\n…", refs: [{ ref, role, name, selector, attrs: { "data-testid", domType, inputType, … } }] }
 * Prefer `refs` (it carries attributes); fall back to parsing `content`.
 */
function fromLiveRead(parsed: Record<string, unknown>): SnapshotNode[] {
  if (Array.isArray(parsed.refs)) {
    const nodes: SnapshotNode[] = [];
    for (const raw of parsed.refs as Record<string, unknown>[]) {
      if (typeof raw?.ref !== "number" || typeof raw.role !== "string") continue;
      const src = (raw.attrs ?? {}) as Record<string, unknown>;
      const attrs: Record<string, string> = {};
      for (const k of LIVE_ATTRS) if (typeof src[k] === "string" && src[k]) attrs[k] = src[k] as string;
      if (typeof src.inputType === "string") attrs.type = src.inputType;
      const idSel = typeof raw.selector === "string" ? /^#([A-Za-z][\w-]*)$/.exec(raw.selector) : null;
      if (idSel && !attrs.id) attrs.id = idSel[1];
      nodes.push({ ref: raw.ref, role: raw.role, name: typeof raw.name === "string" ? raw.name : "", attrs });
    }
    return nodes;
  }
  return typeof parsed.content === "string" ? parseTextSnapshot(parsed.content) : [];
}

function coerceResult(raw: unknown): ToolResult {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    // MCP CallToolResult: { content: [{type:"text", text}], isError }
    if (Array.isArray(obj.content)) {
      const text = (obj.content as { type: string; text?: string }[])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
      let parsed: ToolResult = {};
      try {
        parsed = JSON.parse(text);
        if (!parsed.snapshot) {
          const snap = fromLiveRead(parsed);
          if (snap.length) parsed.snapshot = snap;
        }
      } catch {
        const snap = parseTextSnapshot(text);
        if (snap.length) parsed.snapshot = snap;
        parsed.text = text;
      }
      if (obj.isError) {
        parsed.ok = false;
        parsed.error = parsed.error ?? text.slice(0, 200);
      }
      return parsed;
    }
    return obj as ToolResult;
  }
  return {};
}

export function parseTrajectory(input: string): Trajectory {
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const records: Record<string, unknown>[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`line ${i + 1} is not valid JSON`);
    }
  }
  const isJsonRpc = records.some((r) => r.jsonrpc === "2.0");
  return isJsonRpc ? fromJsonRpc(records) : fromForgeJsonl(records);
}

function fromForgeJsonl(records: Record<string, unknown>[]): Trajectory {
  const traj: Trajectory = { calls: [] };
  for (const r of records) {
    if (r.type === "meta") {
      traj.task = r.task as string | undefined;
      traj.app = r.app as string | undefined;
      traj.started = r.started as string | undefined;
    } else if (r.type === "tool_call" || r.tool) {
      traj.calls.push({
        seq: traj.calls.length,
        ts: r.ts as string | undefined,
        tool: String(r.tool),
        args: (r.args as Record<string, unknown>) ?? {},
        result: coerceResult(r.result),
        usage: r.usage as ToolCall["usage"],
        duration_ms: r.duration_ms as number | undefined,
      });
    }
  }
  return traj;
}

function fromJsonRpc(records: Record<string, unknown>[]): Trajectory {
  const traj: Trajectory = { calls: [] };
  const pending = new Map<unknown, ToolCall>();
  for (const r of records) {
    if (r.method === "tools/call") {
      const params = (r.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const call: ToolCall = { seq: traj.calls.length, tool: String(params.name), args: params.arguments ?? {} };
      traj.calls.push(call);
      pending.set(r.id, call);
    } else if ("result" in r || "error" in r) {
      const call = pending.get(r.id);
      if (!call) continue;
      call.result = "error" in r && r.error ? { ok: false, error: JSON.stringify(r.error).slice(0, 200) } : coerceResult(r.result);
      pending.delete(r.id);
    }
  }
  return traj;
}

export function serializeTrajectory(t: Trajectory): string {
  const out = [JSON.stringify({ type: "meta", task: t.task, app: t.app, started: t.started })];
  for (const c of t.calls) out.push(JSON.stringify({ type: "tool_call", ...c }));
  return out.join("\n") + "\n";
}
