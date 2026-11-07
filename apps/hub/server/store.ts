import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  emptyHealth,
  healthScore,
  lintProcedure,
  lintSummary,
  parseYaml,
  recordResolution,
  scoreProcedure,
  shouldDemote,
  toYaml,
  validateProcedure,
  type Health,
  type Procedure,
  type ResolutionRecord,
} from "@forge/core";

/**
 * Registry store. Trust is computed server-side from reported runs, never
 * taken from the uploaded YAML:
 *   trusted  ← ≥3 consecutive strict, completed runs with no relocation and no
 *              LLM fallback (the browserops-teach promotion rule) and healthy drift
 *   demoted  ← drift health crosses BrowserOps' degradation thresholds
 *   draft    ← everything else (including every freshly published version)
 */
export type Status = "draft" | "trusted" | "demoted";

export interface RunReport {
  version?: number;
  completed: boolean;
  status?: string;
  strict?: boolean;
  used_llm_fallback?: boolean;
  duration_ms: number;
  resolutions?: Record<string, ResolutionRecord>;
  steps?: unknown[];
  divergence?: { step: string; reason: string };
  verify_ok?: boolean;
  environment?: string;
  runner?: string;
}

export const TRUST_STREAK = 3;

export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS procedures (
        name TEXT PRIMARY KEY, domain TEXT, description TEXT, author TEXT,
        latest_version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft', demote_reason TEXT,
        health TEXT, recorded_tokens INTEGER DEFAULT 0, recorded_ms INTEGER DEFAULT 0, recorded_calls INTEGER DEFAULT 0,
        created TEXT NOT NULL, updated TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        name TEXT NOT NULL, version INTEGER NOT NULL, yaml TEXT NOT NULL, created TEXT NOT NULL,
        lint TEXT, compile TEXT, changelog TEXT, PRIMARY KEY (name, version)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, version INTEGER NOT NULL, at TEXT NOT NULL,
        completed INTEGER NOT NULL, strict INTEGER NOT NULL, relocated INTEGER NOT NULL, used_llm INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL, status TEXT, environment TEXT, report TEXT, hub_status TEXT
      );
    `);
  }

  publish(yaml: string, meta: { author?: string; compile?: unknown; changelog?: string } = {}) {
    let doc: Procedure;
    try {
      doc = parseYaml(yaml) as Procedure;
    } catch (e) {
      return { ok: false as const, status: 400, error: `YAML parse error: ${(e as Error).message}` };
    }
    const schema = validateProcedure(doc);
    const lint = lintProcedure(doc);
    if (!schema.valid || lintSummary(lint).errors > 0) {
      return { ok: false as const, status: 422, error: "procedure has schema or lint errors", schema, lint };
    }
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT latest_version FROM procedures WHERE name = ?").get(doc.name) as { latest_version: number } | undefined;
    const version = (existing?.latest_version ?? 0) + 1;
    // Strip client-claimed trust: the registry earns it from runs.
    doc.meta = { version, created: doc.meta?.created ?? now, status: "draft" };
    const canonical = toYaml(doc);
    const c = (meta.compile ?? {}) as { recorded_tokens?: number; recorded_ms?: number; recorded_calls?: number };
    this.db
      .prepare("INSERT INTO versions (name, version, yaml, created, lint, compile, changelog) VALUES (?,?,?,?,?,?,?)")
      .run(doc.name, version, canonical, now, JSON.stringify(lint), meta.compile ? JSON.stringify(meta.compile) : null, meta.changelog ?? null);
    if (existing) {
      this.db
        .prepare("UPDATE procedures SET latest_version=?, status='draft', demote_reason=NULL, health=?, description=?, updated=?, recorded_tokens=COALESCE(?, recorded_tokens), recorded_ms=COALESCE(?, recorded_ms), recorded_calls=COALESCE(?, recorded_calls) WHERE name=?")
        .run(version, JSON.stringify(emptyHealth(now)), doc.description, now, c.recorded_tokens ?? null, c.recorded_ms ?? null, c.recorded_calls ?? null, doc.name);
    } else {
      this.db
        .prepare("INSERT INTO procedures (name, domain, description, author, latest_version, status, health, recorded_tokens, recorded_ms, recorded_calls, created, updated) VALUES (?,?,?,?,?,'draft',?,?,?,?,?,?)")
        .run(doc.name, doc.domain ?? null, doc.description, meta.author ?? "anonymous", version, JSON.stringify(emptyHealth(now)), c.recorded_tokens ?? 0, c.recorded_ms ?? 0, c.recorded_calls ?? 0, now, now);
    }
    return { ok: true as const, name: doc.name, version, lint };
  }

  reportRun(name: string, run: RunReport) {
    const row = this.db.prepare("SELECT * FROM procedures WHERE name = ?").get(name) as Record<string, unknown> | undefined;
    if (!row) return { ok: false as const, status: 404, error: "unknown procedure" };
    const version = run.version ?? (row.latest_version as number);
    const now = new Date().toISOString();
    const relocated = Object.values(run.resolutions ?? {}).some((r) => r.used_relocate);
    const ins = this.db
      .prepare("INSERT INTO runs (name, version, at, completed, strict, relocated, used_llm, duration_ms, status, environment, report) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(name, version, now, run.completed ? 1 : 0, run.strict ? 1 : 0, relocated ? 1 : 0, run.used_llm_fallback ? 1 : 0, Math.round(run.duration_ms), run.status ?? null, run.environment ?? null, JSON.stringify(run));

    if (version !== row.latest_version) return { ok: true as const, status: row.status as Status, note: "run recorded against an older version; health unchanged" };

    let health = (row.health ? JSON.parse(row.health as string) : emptyHealth(now)) as Health;
    for (const [stepId, rec] of Object.entries(run.resolutions ?? {})) health = recordResolution(health, stepId, rec, now);

    const demote = shouldDemote(health);
    let status: Status = row.status as Status;
    let reason: string | null = (row.demote_reason as string | null) ?? null;
    if (demote.demote) {
      status = "demoted";
      reason = demote.reasons.map((r) => `${r.step}: ${r.reason}`).join("; ");
    } else if (status !== "demoted") {
      const streak = this.db
        .prepare("SELECT completed, strict, relocated, used_llm FROM runs WHERE name=? AND version=? ORDER BY id DESC LIMIT ?")
        .all(name, version, TRUST_STREAK) as { completed: number; strict: number; relocated: number; used_llm: number }[];
      const clean = streak.length === TRUST_STREAK && streak.every((r) => r.completed && r.strict && !r.relocated && !r.used_llm);
      status = clean ? "trusted" : run.completed ? status : "draft";
    }
    this.db.prepare("UPDATE procedures SET health=?, status=?, demote_reason=?, updated=? WHERE name=?").run(JSON.stringify(health), status, reason, now, name);
    this.db.prepare("UPDATE runs SET hub_status=? WHERE id=?").run(status, Number(ins.lastInsertRowid));
    return { ok: true as const, status, demote_reason: reason, health_score: healthScore(health) };
  }

  private summarize(row: Record<string, unknown>) {
    const name = row.name as string;
    const health = row.health ? (JSON.parse(row.health as string) as Health) : undefined;
    const agg = this.db
      .prepare("SELECT COUNT(*) AS runs, SUM(completed) AS ok, AVG(CASE WHEN completed=1 THEN duration_ms END) AS avg_ms FROM runs WHERE name=?")
      .get(name) as { runs: number; ok: number | null; avg_ms: number | null };
    const yaml = (this.db.prepare("SELECT yaml FROM versions WHERE name=? AND version=?").get(name, row.latest_version as number) as { yaml: string }).yaml;
    const doc = parseYaml(yaml) as Procedure;
    return {
      name,
      domain: row.domain as string | null,
      description: row.description as string,
      author: row.author as string,
      version: row.latest_version as number,
      status: row.status as Status,
      demote_reason: (row.demote_reason as string | null) ?? null,
      health_score: healthScore(health),
      runs: agg.runs,
      success_rate: agg.runs ? (agg.ok ?? 0) / agg.runs : null,
      avg_replay_ms: agg.avg_ms === null ? null : Math.round(agg.avg_ms),
      recorded_tokens: row.recorded_tokens as number,
      recorded_ms: row.recorded_ms as number,
      recorded_calls: row.recorded_calls as number,
      tokens_saved: (row.recorded_tokens as number) * (agg.ok ?? 0),
      steps: doc.steps.length,
      side_effects: doc.side_effects ?? [],
      inputs: Object.keys(doc.inputs ?? {}),
      tags: doc.tags ?? [],
      triggers: doc.triggers ?? [],
      updated: row.updated as string,
    };
  }

  list(query = "") {
    const rows = this.db.prepare("SELECT * FROM procedures ORDER BY updated DESC").all() as Record<string, unknown>[];
    const items = rows.map((r) => this.summarize(r));
    if (!query.trim()) return items;
    return items
      .map((i) => ({ ...i, score: scoreProcedure(query, { name: i.name, description: i.description, domain: i.domain ?? undefined, triggers: i.triggers, tags: i.tags }) }))
      .filter((i) => i.score > 0.15)
      .sort((a, b) => b.score - a.score);
  }

  get(name: string) {
    const row = this.db.prepare("SELECT * FROM procedures WHERE name=?").get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    const versions = this.db.prepare("SELECT version, created, lint, compile, changelog FROM versions WHERE name=? ORDER BY version DESC").all(name) as Record<string, string | number | null>[];
    const yaml = (this.db.prepare("SELECT yaml FROM versions WHERE name=? AND version=?").get(name, row.latest_version as number) as { yaml: string }).yaml;
    const runs = this.db.prepare("SELECT id, version, at, completed, strict, relocated, used_llm, duration_ms, status, environment, report FROM runs WHERE name=? ORDER BY id DESC LIMIT 50").all(name) as Record<string, unknown>[];
    const health = row.health ? (JSON.parse(row.health as string) as Health) : emptyHealth(row.updated as string);
    return {
      ...this.summarize(row),
      yaml,
      procedure: parseYaml(yaml) as Procedure,
      health,
      demotion: shouldDemote(health),
      versions: versions.map((v) => ({ version: v.version, created: v.created, changelog: v.changelog, lint: v.lint ? JSON.parse(v.lint as string) : [], compile: v.compile ? JSON.parse(v.compile as string) : null })),
      run_log: runs.map((r) => ({ ...r, report: r.report ? JSON.parse(r.report as string) : null })),
    };
  }

  /** YAML as `procedures_save` would store it locally, with the registry's trust + health attached. */
  exportYaml(name: string): string | null {
    const d = this.get(name);
    if (!d) return null;
    const p = d.procedure;
    p.meta = {
      version: d.version,
      created: p.meta?.created ?? d.updated,
      ...(d.status === "trusted" ? { last_verified: d.updated } : {}),
      status: d.status === "trusted" ? "trusted" : "draft",
      health: d.health,
    };
    return toYaml(p);
  }

  stats() {
    const items = this.list();
    const runs = this.db.prepare("SELECT COUNT(*) AS n, SUM(completed) AS ok FROM runs").get() as { n: number; ok: number | null };
    const median = (this.db.prepare("SELECT duration_ms FROM runs WHERE completed=1 ORDER BY duration_ms").all() as { duration_ms: number }[]).map((r) => r.duration_ms);
    return {
      procedures: items.length,
      trusted: items.filter((i) => i.status === "trusted").length,
      demoted: items.filter((i) => i.status === "demoted").length,
      runs: runs.n,
      successful_runs: runs.ok ?? 0,
      tokens_saved: items.reduce((s, i) => s + i.tokens_saved, 0),
      median_replay_ms: median.length ? median[Math.floor(median.length / 2)] : null,
    };
  }
}
