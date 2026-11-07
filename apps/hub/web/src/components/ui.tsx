import { useState, type ReactNode } from "react";
import type { Status } from "../api.ts";

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

export function TierChip({ tier }: { tier: number | null | undefined }) {
  if (!tier) return null;
  const title = tier === 1 ? "Tier 1 — contract attribute (data-testid, aria-label, name, href). Survives redesigns." : tier === 2 ? "Tier 2 — derived from visible copy. Breaks when text changes." : "Tier 3 — positional (nth). Breaks on reorder.";
  return (
    <span className={`tier t${tier}`} title={title}>
      T{tier}
    </span>
  );
}

export function HealthMeter({ score }: { score: number | null }) {
  if (score === null) return <span className="hint">no runs yet</span>;
  const color = score >= 85 ? "var(--green)" : score >= 60 ? "var(--amber)" : "var(--red)";
  return (
    <div className="meter" title="Forge health score: locator tier quality minus drift signals">
      <div className="bar">
        <i style={{ width: `${score}%`, background: color }} />
      </div>
      <span className="n">{score}</span>
    </div>
  );
}

export function CopyCmd({ cmd }: { cmd: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="cmd">
      <span className="dollar">$</span>
      {cmd}
      <button
        onClick={() => {
          navigator.clipboard?.writeText(cmd).catch(() => {});
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }}
        aria-label="Copy command"
      >
        {done ? "copied" : "copy"}
      </button>
    </span>
  );
}

/** Tiny YAML highlighter: keys, strings, templates, comments. */
export function Yaml({ text }: { text: string }) {
  const lines = text.split("\n").map((line, i) => {
    const parts: ReactNode[] = [];
    const m = /^(\s*-?\s*)([A-Za-z_][\w.-]*)(:)(.*)$/.exec(line);
    if (m) {
      parts.push(m[1], <span key="k" className="k">{m[2]}</span>, m[3]);
      parts.push(...valueParts(m[4]));
    } else if (/^\s*#/.test(line)) parts.push(<span key="c" className="c">{line}</span>);
    else parts.push(...valueParts(line));
    return (
      <span key={i}>
        {parts}
        {"\n"}
      </span>
    );
  });
  return <pre className="yaml">{lines}</pre>;
}

function valueParts(v: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\{\{\s*\w+\s*\}\})/g;
  let last = 0;
  for (const m of v.matchAll(re)) {
    if (m.index! > last) out.push(<span key={`s${last}`} className="s">{v.slice(last, m.index)}</span>);
    out.push(<span key={`t${m.index}`} className="t">{m[0]}</span>);
    last = m.index! + m[0].length;
  }
  if (last < v.length) out.push(<span key={`e${last}`} className={/^\s*(true|false|\d+)$/.test(v.slice(last)) ? "" : "s"}>{v.slice(last)}</span>);
  return out;
}
