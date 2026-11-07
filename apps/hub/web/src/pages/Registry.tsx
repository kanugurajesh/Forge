import { useEffect, useState } from "react";
import { api, fmt, type Stats, type Summary } from "../api.ts";
import { CopyCmd, HealthMeter, StatusBadge } from "../components/ui.tsx";

export function Registry() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [items, setItems] = useState<Summary[] | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.stats().then(setStats).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => api.list(q).then(setItems).catch((e) => setErr(e.message)), 150);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <>
      <section className="hero">
        <h1>Teach a browser flow once. Replay it without the agent.</h1>
        <p>
          Forge compiles one recorded agent run into a BrowserOps procedure, then the Hub tracks whether it keeps working. It earns trust from verified runs,
          demotes on drift, and heals from the live page.
        </p>
        <div className="ctas">
          <a className="btn primary" href="#/compile">
            Compile an agent run →
          </a>
          <CopyCmd cmd="forge pull relay.send_email" />
        </div>
      </section>

      {err && <div className="callout red">Hub API error: {err}</div>}

      <div className="stats">
        <div className="stat">
          <div className="v">{fmt.n(stats?.procedures)}</div>
          <div className="k">procedures</div>
        </div>
        <div className="stat">
          <div className="v">{fmt.n(stats?.trusted)}</div>
          <div className="k">trusted</div>
        </div>
        <div className="stat">
          <div className="v">{fmt.n(stats?.successful_runs)}</div>
          <div className="k">verified replays</div>
        </div>
        <div className="stat">
          <div className="v">{stats ? fmt.k(stats.tokens_saved) : "–"}</div>
          <div className="k">agent tokens not spent</div>
        </div>
        <div className="stat">
          <div className="v">{fmt.ms(stats?.median_replay_ms)}</div>
          <div className="k">median replay</div>
        </div>
      </div>

      <div className="how">
        <div className="card">
          <div className="n">01 · compile</div>
          <h4>One run in, one procedure out</h4>
          <p>Drops observations, failed and zero-effect clicks and retries. Lifts typed values into inputs, proposes tier-1 locators and derives expects from page effects.</p>
        </div>
        <div className="card">
          <div className="n">02 · verify</div>
          <h4>Trust is earned, not uploaded</h4>
          <p>A procedure becomes trusted only after 3 consecutive strict runs with no relocation and no LLM fallback, the same promotion rule browserops-teach uses.</p>
        </div>
        <div className="card">
          <div className="n">03 · watch drift</div>
          <h4>Demote before it lies</h4>
          <p>Every run reports how each locator resolved. When a step crosses BrowserOps' drift thresholds, the procedure is demoted with a reason, and you can heal it.</p>
        </div>
      </div>

      <div className="searchbar">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search procedures: “send email”, “search mail”, “relay”…" aria-label="Search procedures" />
        <span className="hint">ranked with the BrowserOps procedures_search tokenizer</span>
      </div>

      <div className="list">
        {items === null && <div className="empty">Loading…</div>}
        {items?.length === 0 && (
          <div className="empty">
            {q ? "No procedures match." : <>Registry is empty. Run <code>npm run demo</code> or compile a trajectory.</>}
          </div>
        )}
        {items?.map((p) => (
          <a key={p.name} className="item" href={`#/p/${encodeURIComponent(p.name)}`}>
            <div>
              <div className="title">
                <span className="name">{p.name}</span>
                <StatusBadge status={p.status} />
                <span className="hint">v{p.version}</span>
              </div>
              <div className="desc">{p.description}</div>
              <div className="meta">
                {p.domain && <span className="tag">{p.domain}</span>}
                <span className="tag">{p.steps} steps</span>
                {p.inputs.length > 0 && <span className="tag">inputs: {p.inputs.join(", ")}</span>}
                {p.side_effects.map((s) => (
                  <span key={s} className="tag warn">
                    {s}
                  </span>
                ))}
              </div>
            </div>
            <div className="cell">
              <div className="k">health</div>
              <HealthMeter score={p.health_score} />
            </div>
            <div className="cell">
              <div className="k">runs</div>
              <div className="v">
                {p.runs} <span className="hint">{p.success_rate !== null ? `· ${Math.round(p.success_rate * 100)}% ok` : ""}</span>
              </div>
            </div>
            <div className="cell">
              <div className="k">agent → replay</div>
              <div className="v">
                {p.recorded_tokens ? `~${fmt.k(p.recorded_tokens)} tok` : "–"} → <span className="ok">0</span>
              </div>
              <div className="hint">{p.avg_replay_ms ? `${fmt.ms(p.avg_replay_ms)} avg replay` : ""}</div>
            </div>
          </a>
        ))}
      </div>
    </>
  );
}
