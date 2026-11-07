import { Fragment, useEffect, useState } from "react";
import { classifyLocator, describeLocator } from "../../../../../packages/core/src/locator.ts";
import { degradeReason, RELOCATE_MIN_RUNS, RELOCATE_RATE_THRESHOLD } from "../../../../../packages/core/src/health.ts";
import type { Expect, Step, StepHealth } from "../../../../../packages/core/src/types.ts";
import { api, fmt, type Detail } from "../api.ts";
import { CopyCmd, HealthMeter, StatusBadge, TierChip, Yaml } from "../components/ui.tsx";

type Tab = "steps" | "yaml" | "runs" | "versions" | "trace";

function expectText(e: Expect | undefined): string | null {
  if (!e) return null;
  return Object.entries(e)
    .filter(([k]) => k !== "timeout_ms" && k !== "poll_interval_ms")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ") || null;
}

function StepDrift({ h }: { h: StepHealth | undefined }) {
  if (!h || h.runs === 0) return null;
  const rate = h.relocates / h.runs;
  const reason = degradeReason(h);
  return (
    <div className={`drift ${reason ? "bad" : ""}`}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <span>
          {h.runs} resolves · <b className={h.relocates ? "warn-t" : ""}>{h.relocates} relocated</b> · {h.ambiguous_resolves} ambiguous · {h.target_changed} target changes
        </span>
        <span className="hint">avg matches {h.avg_match_count ?? "–"}</span>
      </div>
      <div title={`relocate rate ${(rate * 100).toFixed(0)}% — demotes above ${RELOCATE_RATE_THRESHOLD * 100}% once runs ≥ ${RELOCATE_MIN_RUNS}`}>
        <div className="thr">
          <i style={{ width: `${Math.min(100, rate * 100)}%`, background: rate > RELOCATE_RATE_THRESHOLD ? "var(--red)" : rate > 0 ? "var(--amber)" : "var(--green)" }} />
          <b style={{ left: `${RELOCATE_RATE_THRESHOLD * 100}%` }} />
        </div>
      </div>
      {reason && <b className="bad">Degraded: {reason}</b>}
    </div>
  );
}

function StepRow({ step, i, h }: { step: Step; i: number; h?: StepHealth }) {
  const tier = classifyLocator(step.locator);
  const exp = expectText(step.expect);
  return (
    <div className="step">
      <div className="idx">{i + 1}</div>
      <div>
        <div className="head">
          <span className="verb">{step.do}</span>
          <span className="goal">{step.goal ?? step.id}</span>
          <span className="sid">{step.id}</span>
        </div>
        <div className="rows">
          {step.locator && (
            <div className="r">
              <span>locator</span>
              <code>{describeLocator(step.locator)}</code>
              <TierChip tier={tier} />
            </div>
          )}
          {step.with && Object.keys(step.with).length > 0 && (
            <div className="r">
              <span>with</span>
              <code>{JSON.stringify(step.with)}</code>
            </div>
          )}
          {exp && (
            <div className="r">
              <span>expect</span>
              <code>{exp}</code>
            </div>
          )}
          {step.fallback && (
            <div className="r">
              <span>fallback</span>
              <code>
                {step.fallback.strategy}
                {step.fallback.retry ? ` ×${step.fallback.retry.attempts}` : ""}
              </code>
            </div>
          )}
        </div>
        <StepDrift h={h} />
      </div>
    </div>
  );
}

export function ProcedurePage({ name }: { name: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("steps");

  useEffect(() => {
    setD(null);
    api.get(name).then(setD).catch((e) => setErr(e.message));
  }, [name]);

  if (err) return <div className="callout red" style={{ marginTop: 30 }}>{err}</div>;
  if (!d) return <div className="empty">Loading…</div>;

  const p = d.procedure;
  const compiled = d.versions.find((v) => v.compile)?.compile ?? null;
  const lastRuns = d.run_log.filter((r) => r.version === d.version);
  const streak = (() => {
    let n = 0;
    for (const r of lastRuns) {
      if (r.completed && r.strict && !r.relocated && !r.used_llm) n++;
      else break;
    }
    return n;
  })();

  return (
    <>
      <div className="page-head">
        <div className="crumb">
          <a href="#/">Registry</a> / {p.domain ?? "procedures"}
        </div>
        <h1>
          {d.name} <StatusBadge status={d.status} /> <span className="hint" style={{ fontFamily: "var(--sans)", fontSize: 14 }}>v{d.version}</span>
        </h1>
        <p>{d.description}</p>
      </div>

      {d.status === "demoted" && (
        <div className="callout red">
          <div className="grow">
            <b>Demoted: drift health crossed the BrowserOps threshold</b>
            {d.demote_reason}. Runs may still complete through relocation, but the procedure no longer resolves the way it was verified, so agents shouldn't trust it
            blindly.
          </div>
          <CopyCmd cmd={`forge heal ${d.name} --publish`} />
        </div>
      )}
      {d.status === "draft" && (
        <div className="callout amber">
          <div className="grow">
            <b>Draft: {streak}/3 clean strict runs on v{d.version}</b>
            Trust is earned with 3 consecutive strict runs that complete with no relocation and no LLM fallback.
          </div>
          <CopyCmd cmd={`forge run ${d.name} --strict ${d.inputs.map((i) => `-i ${i}=…`).join(" ")}`} />
        </div>
      )}
      {d.status === "trusted" && (
        <div className="callout green">
          <div className="grow">
            <b>Trusted, and installable into BrowserOps</b>
            Pull it into <code>~/browserops/procedures/</code> and every MCP client using BrowserOps can find it with <code>procedures_search</code>.
          </div>
          <CopyCmd cmd={`forge pull ${d.name}`} />
        </div>
      )}

      <div className="kpis">
        <div className="kpi">
          <div className="k">health</div>
          <HealthMeter score={d.health_score} />
        </div>
        <div className="kpi">
          <div className="k">runs</div>
          <div className="v">{d.runs}</div>
          <div className="s">{d.success_rate !== null ? `${Math.round(d.success_rate * 100)}% completed` : "none yet"}</div>
        </div>
        <div className="kpi">
          <div className="k">avg replay</div>
          <div className="v">{fmt.ms(d.avg_replay_ms)}</div>
          <div className="s">{p.steps.length} deterministic steps</div>
        </div>
        <div className="kpi">
          <div className="k">recorded agent run</div>
          <div className="v">{d.recorded_calls || "–"} calls</div>
          <div className="s">{d.recorded_tokens ? `~${fmt.n(d.recorded_tokens)} tokens` : "authored by hand"}</div>
        </div>
        <div className="kpi">
          <div className="k">LLM tokens per replay</div>
          <div className="v ok">0</div>
          <div className="s">{fmt.k(d.tokens_saved)} saved so far</div>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {(["steps", "yaml", "runs", "versions", ...(compiled ? ["trace"] : [])] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)} role="tab" aria-selected={tab === t}>
            {t === "trace" ? "compile trace" : t}
            {t === "runs" ? ` (${d.runs})` : t === "versions" ? ` (${d.versions.length})` : ""}
          </button>
        ))}
      </div>

      {tab === "steps" && (
        <div className="grid2">
          <div className="steps">
            {p.steps.map((s, i) => (
              <StepRow key={s.id} step={s} i={i} h={d.health.steps[s.id]} />
            ))}
          </div>
          <aside>
            <div className="panel">
              <h3>Inputs</h3>
              {Object.entries(p.inputs ?? {}).length === 0 && <span className="hint">none</span>}
              <div className="kv">
                {Object.entries(p.inputs ?? {}).map(([k, v]) => (
                  <Fragment key={k}>
                    <code>{`{{${k}}}`}</code>
                    <span>
                      {v.type}
                      {v.destructive && <span className="tag warn" style={{ marginLeft: 6 }}>destructive</span>}
                    </span>
                  </Fragment>
                ))}
              </div>
            </div>
            <div className="panel">
              <h3>Guards</h3>
              <div className="kv">
                <span className="k">side effects</span>
                <span>{p.side_effects?.join(", ") || "none"}</span>
                <span className="k">forbidden</span>
                <span>
                  {(p.forbidden?.locators ?? []).map((l, i) => (
                    <div key={i}>
                      <code>{describeLocator(l)}</code>
                    </div>
                  ))}
                  {!p.forbidden?.locators?.length && "none"}
                </span>
                <span className="k">verify</span>
                <code>{expectText(p.verify) ?? "none"}</code>
              </div>
            </div>
            <div className="panel">
              <h3>Install</h3>
              <CopyCmd cmd={`forge pull ${d.name}`} />
              <p className="hint" style={{ marginBottom: 0 }}>
                Requires <code>browserops feature enable procedures</code>.
              </p>
            </div>
          </aside>
        </div>
      )}

      {tab === "yaml" && (
        <div style={{ marginBottom: 60 }}>
          <Yaml text={d.yaml} />
        </div>
      )}

      {tab === "runs" && (
        <div style={{ marginBottom: 60, overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>when</th>
                <th>ver</th>
                <th>env</th>
                <th>result</th>
                <th>mode</th>
                <th>duration</th>
                <th>notes</th>
              </tr>
            </thead>
            <tbody>
              {d.run_log.map((r, i) => {
                const reloc = r.report?.steps?.filter((s) => s.relocated) ?? [];
                const older = d.run_log[i + 1];
                const transitioned = r.hub_status && (!older || older.version !== r.version || older.hub_status !== r.hub_status) && r.hub_status !== "draft";
                return (
                  <tr key={r.id}>
                    <td>{fmt.ago(r.at)}</td>
                    <td>v{r.version}</td>
                    <td>
                      <code>{r.environment ?? "–"}</code>
                    </td>
                    <td className={r.completed ? "ok" : "bad"}>{r.completed ? "completed" : r.status}</td>
                    <td>{r.strict ? "strict" : "hybrid"}</td>
                    <td>{fmt.ms(r.duration_ms)}</td>
                    <td>
                      {transitioned && (
                        <div style={{ marginBottom: 3 }}>
                          → <StatusBadge status={r.hub_status!} />
                        </div>
                      )}
                      {reloc.map((s) => (
                        <div key={s.id} className="warn-t">
                          ↻ {s.id} → {s.relocated_to}
                        </div>
                      ))}
                      {r.report?.divergence && (
                        <div className="bad">
                          {r.report.divergence.step}: {r.report.divergence.reason}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {d.run_log.length === 0 && <div className="empty">No runs reported yet.</div>}
        </div>
      )}

      {tab === "versions" && (
        <div style={{ marginBottom: 60 }}>
          {d.versions.map((v) => (
            <div className="panel" key={v.version}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <b>v{v.version}</b>
                <span className="hint">{fmt.ago(v.created)}</span>
              </div>
              {v.changelog && <pre style={{ whiteSpace: "pre-wrap", margin: "8px 0 0", color: "var(--ink-2)" }}>{v.changelog}</pre>}
              {v.lint.length > 0 && (
                <div className="hint" style={{ marginTop: 6 }}>
                  lint: {v.lint.map((f) => `${f.rule}${f.step ? `@${f.step}` : ""}`).join(", ")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "trace" && compiled && (
        <div style={{ marginBottom: 60 }}>
          <p className="hint">
            The agent run this procedure was compiled from: {compiled.recorded_calls} tool calls, of which {compiled.kept_steps} became steps (including the inserted
            entry wait).
          </p>
          <div className="calls">
            {compiled.events.map((e) => (
              <div key={e.seq} className={`call ${e.decision}`}>
                <span className="seq">{e.seq}</span>
                <span className="tool">{e.tool}</span>
                <span className={`why ${e.decision}`}>{e.decision === "kept" ? `→ ${e.step_id}` : e.reason?.replace(/_/g, " ")}</span>
                <span className="detail hint">{e.detail}</span>
                <span className="tok">{fmt.k(e.tokens)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
