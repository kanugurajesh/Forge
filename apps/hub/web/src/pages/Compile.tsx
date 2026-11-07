import { useState, type DragEvent } from "react";
import type { CompileResult } from "../../../../../packages/core/src/compiler.ts";
import { api, fmt } from "../api.ts";
import { Yaml } from "../components/ui.tsx";

const SAMPLES = [
  { file: "relay-send-email.trajectory.jsonl", label: "Noisy “send email” run", name: "relay.send_email" },
  { file: "relay-search.trajectory.jsonl", label: "“Search mail” run", name: "relay.search_mail" },
  { file: "relay-send-email.live.mcp.jsonl", label: "Live BrowserOps run (MCP)", name: "relay.send_email_live" },
];

const REASON_LABEL: Record<string, string> = {
  observation: "observation",
  failed: "failed call",
  no_page_effect: "no page effect",
  superseded: "superseded retry",
  redundant_navigation: "redundant nav",
  unreplayable: "unreplayable",
};

export function Compile() {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [res, setRes] = useState<CompileResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [published, setPublished] = useState<string | null>(null);

  const run = async (t = text, n = name) => {
    setBusy(true);
    setErr(null);
    setPublished(null);
    try {
      setRes(await api.compile(t, n || undefined));
    } catch (e) {
      setErr((e as Error).message);
      setRes(null);
    } finally {
      setBusy(false);
    }
  };

  const loadSample = async (s: (typeof SAMPLES)[number]) => {
    try {
      const t = await api.fixture(s.file);
      const n = `${s.name}_copy`;
      setText(t);
      setName(n);
      run(t, n);
    } catch {
      setErr("Sample trajectories are created by `npm run demo`. Run it once, then reload.");
    }
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) setText(await f.text());
  };

  const publish = async () => {
    if (!res) return;
    try {
      const r = await api.publish(res.yaml, { ...res.stats, tiers: res.tiers, events: res.events, warnings: res.warnings });
      setPublished(r.name);
      location.hash = `#/p/${encodeURIComponent(r.name)}`;
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const errors = res?.lint.filter((f) => f.severity === "error").length ?? 0;
  const droppedTotal = res ? Object.values(res.stats.dropped).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="compile">
      <div>
        <div className="page-head" style={{ paddingTop: 8 }}>
          <h1 style={{ fontFamily: "var(--sans)", fontWeight: 600 }}>Compile an agent run</h1>
          <p>Paste a trajectory: Forge JSONL, or a raw MCP JSON-RPC transcript of browser_* tools/call messages.</p>
        </div>
        <div className="row">
          {SAMPLES.map((s) => (
            <button key={s.file} className="btn sm" onClick={() => loadSample(s)}>
              Load: {s.label}
            </button>
          ))}
        </div>
        <div className={`drop ${over ? "over" : ""}`} onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={onDrop}>
          drop a .jsonl file here
        </div>
        <div className="row">
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder='{"type":"meta","task":"…"}&#10;{"type":"tool_call","tool":"browser_click","args":{"ref":12},"result":{…}}' spellCheck={false} aria-label="Trajectory JSONL" />
        </div>
        <div className="row">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="procedure name (optional), e.g. gmail.send_email" aria-label="Procedure name" />
          <button className="btn primary" disabled={!text.trim() || busy} onClick={() => run()}>
            {busy ? "Compiling…" : "Compile"}
          </button>
        </div>
        {err && <div className="callout red">{err}</div>}
      </div>

      <div>
        {!res && (
          <div className="panel" style={{ marginTop: 8 }}>
            <h3>What the compiler does</h3>
            <ol style={{ margin: 0, paddingLeft: 18, color: "var(--ink-2)", lineHeight: 1.7 }}>
              <li>Drops observation calls. The runtime re-reads before every locator step.</li>
              <li>Drops failed calls and clicks whose page_effect is zero, and collapses retries.</li>
              <li>Maps each ref to the smallest unique locator, preferring tier-1 attributes.</li>
              <li>Lifts typed literals into <code>{"{{inputs}}"}</code>, so sample values never reach the YAML.</li>
              <li>Derives <code>expect</code> from observed effects (new dialog, endpoint, URL).</li>
              <li>Infers side effects, destructive inputs, forbidden controls and a verify block.</li>
              <li>Validates against the BrowserOps v1 schema and lints with the teach-skill rules.</li>
            </ol>
          </div>
        )}
        {res && (
          <>
            <div className="funnel">
              <div className="kpi">
                <div className="k">recorded</div>
                <div className="v">{res.stats.recorded_calls} calls</div>
                <div className="s">~{fmt.n(res.stats.recorded_tokens)} tokens</div>
              </div>
              <div className="kpi">
                <div className="k">dropped</div>
                <div className="v">{droppedTotal}</div>
                <div className="s">
                  {Object.entries(res.stats.dropped)
                    .filter(([, v]) => v)
                    .map(([k, v]) => `${v} ${REASON_LABEL[k]}`)
                    .join(" · ")}
                </div>
              </div>
              <div className="kpi">
                <div className="k">procedure</div>
                <div className="v">{res.stats.kept_steps} steps</div>
                <div className="s">
                  locators T1 {res.tiers["1"]} · T2 {res.tiers["2"]} · T3 {res.tiers["3"]}
                </div>
              </div>
              <div className="kpi">
                <div className="k">per replay</div>
                <div className="v ok">0 tokens</div>
                <div className="s">{res.schema.valid ? "schema valid" : <span className="err">schema invalid</span>}</div>
              </div>
            </div>

            <div className="section-title">
              <span>
                {res.procedure.name} <span className="hint">· inputs: {Object.keys(res.procedure.inputs ?? {}).join(", ") || "none"}</span>
              </span>
              <button className="btn primary sm" disabled={errors > 0 || !res.schema.valid} onClick={publish}>
                {published ? "Published ✓" : "Publish to Hub as draft"}
              </button>
            </div>

            <div className="calls">
              {res.events.map((e) => (
                <div key={e.seq} className={`call ${e.decision}`}>
                  <span className="seq">{e.seq}</span>
                  <span className="tool">{e.tool}</span>
                  <span className={`why ${e.decision}`}>{e.decision === "kept" ? `→ ${e.step_id}` : REASON_LABEL[e.reason ?? ""]}</span>
                  <span className="detail hint">{e.detail}</span>
                  <span className="tok">{fmt.k(e.tokens)}</span>
                </div>
              ))}
            </div>

            {(res.lint.length > 0 || res.warnings.length > 0) && (
              <>
                <div className="section-title">Lint & warnings</div>
                <div className="lint">
                  {res.lint.map((f, i) => (
                    <div className="f" key={i}>
                      <span className={`sev ${f.severity === "error" ? "err" : f.severity === "warning" ? "warn-t" : "hint"}`}>{f.severity}</span>
                      <code>{f.rule}</code>
                      <span>
                        {f.step && <code>{f.step}: </code>}
                        {f.message}
                        {f.fix && <span className="hint"> → {f.fix}</span>}
                      </span>
                    </div>
                  ))}
                  {res.warnings.map((w, i) => (
                    <div className="f" key={`w${i}`}>
                      <span className="sev warn-t">note</span>
                      <code>compiler</code>
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="section-title">
              Procedure YAML <span className="hint">samples kept out: {Object.entries(res.samples).map(([k, v]) => `${k}="${v}"`).join(", ") || "none"}</span>
            </div>
            <Yaml text={res.yaml} />
          </>
        )}
      </div>
    </div>
  );
}
