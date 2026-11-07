import type { CompileResult, Health, LintFinding, Procedure } from "@forge/core";

export type Status = "draft" | "trusted" | "demoted";

export interface Summary {
  name: string;
  domain: string | null;
  description: string;
  author: string;
  version: number;
  status: Status;
  demote_reason: string | null;
  health_score: number | null;
  runs: number;
  success_rate: number | null;
  avg_replay_ms: number | null;
  recorded_tokens: number;
  recorded_ms: number;
  recorded_calls: number;
  tokens_saved: number;
  steps: number;
  side_effects: string[];
  inputs: string[];
  tags: string[];
  updated: string;
}

export interface RunRow {
  id: number;
  version: number;
  at: string;
  completed: number;
  strict: number;
  relocated: number;
  used_llm: number;
  duration_ms: number;
  status: string;
  environment: string | null;
  hub_status: "draft" | "trusted" | "demoted" | null;
  report: {
    steps?: { id: string; ok: boolean; ms: number; relocated?: boolean; relocated_to?: string; tier?: number }[];
    divergence?: { step: string; reason: string };
  } | null;
}

export interface Detail extends Summary {
  yaml: string;
  procedure: Procedure;
  health: Health;
  demotion: { demote: boolean; reasons: { step: string; reason: string }[] };
  versions: {
    version: number;
    created: string;
    changelog: string | null;
    lint: LintFinding[];
    compile: (CompileResult["stats"] & { tiers: Record<string, number>; events: CompileResult["events"]; warnings: string[] }) | null;
  }[];
  run_log: RunRow[];
}

export interface Stats {
  procedures: number;
  trusted: number;
  demoted: number;
  runs: number;
  successful_runs: number;
  tokens_saved: number;
  median_replay_ms: number | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const ct = r.headers.get("content-type") ?? "";
  const body = ct.startsWith("application/json") ? await r.json() : await r.text();
  if (!r.ok) throw Object.assign(new Error(typeof body === "object" ? body.error : String(body)), { body });
  return body as T;
}

export const api = {
  stats: () => req<Stats>("/api/stats"),
  list: (q = "") => req<Summary[]>(`/api/procedures?q=${encodeURIComponent(q)}`),
  get: (name: string) => req<Detail>(`/api/procedures/${encodeURIComponent(name)}`),
  compile: (trajectory: string, name?: string) => req<CompileResult>("/api/compile", { method: "POST", body: JSON.stringify({ trajectory, name }) }),
  publish: (yaml: string, compile?: unknown) =>
    req<{ name: string; version: number }>("/api/procedures", { method: "POST", body: JSON.stringify({ yaml, compile, author: "hub-ui", changelog: "Published from the Compile playground" }) }),
  fixture: (file: string) => req<string>(`/api/fixtures/${file}`),
};

export const fmt = {
  n: (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toLocaleString()),
  k: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(v)),
  ms: (v: number | null | undefined) => (v === null || v === undefined ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`),
  ago: (iso: string) => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  },
};
