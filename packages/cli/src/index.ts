#!/usr/bin/env node
/**
 * forge — compile agent runs into BrowserOps procedures, and share them.
 *
 *   forge compile <trajectory.jsonl> [--name app.flow] [--out file.yaml] [--json]
 *   forge lint    <procedure.yaml>
 *   forge publish <procedure.yaml> [--changelog "..."]
 *   forge search  <query...>
 *   forge pull    <name> [--dir ~/browserops/procedures]
 *   forge run     <name|file.yaml> [--input k=v ...] [--strict] [--headed] [--no-report]
 *   forge heal    <name> [--input k=v ...] [--publish]
 *
 * Hub: $FORGE_HUB (default http://127.0.0.1:4317)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  compileTrajectory,
  describeLocator,
  lintProcedure,
  lintSummary,
  parseTrajectory,
  parseYaml,
  toYaml,
  validateProcedure,
  type Procedure,
} from "@forge/core";

const HUB = (process.env.FORGE_HUB ?? "http://127.0.0.1:4317").replace(/\/$/, "");
const tty = process.stdout.isTTY;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: paint(2), bold: paint(1), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36) };

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const inputs: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input" || a === "-i") {
      const [k, ...v] = (argv[++i] ?? "").split("=");
      inputs[k] = v.join("=");
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !["strict", "headed", "json", "publish", "no-report"].includes(key)) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags, inputs };
}

async function hub<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(HUB + path, { headers: { "content-type": "application/json" }, ...init });
  } catch {
    throw new Error(`can't reach Forge Hub at ${HUB} — start it with \`npm run hub\` or set FORGE_HUB`);
  }
  const text = await r.text();
  const body = r.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
  if (!r.ok) throw Object.assign(new Error(typeof body === "object" ? body.error : text), { body });
  return body as T;
}

function printLint(p: Procedure) {
  const schema = validateProcedure(p);
  const lint = lintProcedure(p);
  const sum = lintSummary(lint);
  console.log(`schema ${schema.valid ? c.green("valid") : c.red("invalid")} · ${sum.errors} errors · ${sum.warnings} warnings · ${sum.infos} info`);
  for (const f of lint) {
    const sev = f.severity === "error" ? c.red("error") : f.severity === "warning" ? c.yellow("warn ") : c.dim("info ");
    console.log(`  ${sev} ${f.rule.padEnd(20)} ${f.step ? c.cyan(f.step) + " " : ""}${f.message}${f.fix ? c.dim(`  → ${f.fix}`) : ""}`);
  }
  return sum.errors === 0 && schema.valid;
}

async function loadProcedure(ref: string): Promise<Procedure> {
  if (existsSync(ref)) return parseYaml(readFileSync(ref, "utf8")) as Procedure;
  return parseYaml(await hub<string>(`/api/procedures/${encodeURIComponent(ref)}/yaml`)) as Procedure;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags, inputs } = parseArgs(rest);

  switch (cmd) {
    case "compile": {
      if (!pos[0]) throw new Error("usage: forge compile <trajectory.jsonl>");
      const res = compileTrajectory(parseTrajectory(readFileSync(pos[0], "utf8")), {
        name: flags.name as string | undefined,
        app: flags.app as string | undefined,
      });
      if (flags.json) return console.log(JSON.stringify(res, null, 2));
      for (const e of res.events) {
        const tag = e.decision === "kept" ? c.green("keep ") : c.dim(`drop:${e.reason}`);
        console.log(`${c.dim(String(e.seq).padStart(3))} ${e.tool.padEnd(22)} ${tag.padEnd(tty ? 33 : 24)} ${c.dim(e.detail)}`);
      }
      const s = res.stats;
      console.log(`\n${c.bold(res.procedure.name)}: ${s.recorded_calls} calls → ${s.kept_steps} steps · tiers ${JSON.stringify(res.tiers)} · ~${s.recorded_tokens.toLocaleString()} tokens/run saved`);
      printLint(res.procedure);
      for (const w of res.warnings) console.log(c.yellow(`  ! ${w}`));
      const out = (flags.out as string) ?? `${res.procedure.name}.yaml`;
      writeFileSync(out, res.yaml);
      console.log(`\nwrote ${out}  ${c.dim(`(samples kept out of the YAML: ${Object.keys(res.samples).join(", ") || "none"})`)}`);
      return;
    }
    case "lint": {
      if (!pos[0]) throw new Error("usage: forge lint <procedure.yaml>");
      process.exitCode = printLint(parseYaml(readFileSync(pos[0], "utf8")) as Procedure) ? 0 : 1;
      return;
    }
    case "publish": {
      if (!pos[0]) throw new Error("usage: forge publish <procedure.yaml>");
      const r = await hub<{ name: string; version: number }>("/api/procedures", {
        method: "POST",
        body: JSON.stringify({ yaml: readFileSync(pos[0], "utf8"), author: flags.author ?? process.env.USER ?? process.env.USERNAME, changelog: flags.changelog }),
      });
      console.log(`published ${c.bold(r.name)} v${r.version} → ${c.yellow("draft")} (3 clean strict runs to earn trust)`);
      return;
    }
    case "search": {
      const items = await hub<{ name: string; status: string; description: string; health_score: number | null; runs: number }[]>(
        `/api/procedures?q=${encodeURIComponent(pos.join(" "))}`,
      );
      if (!items.length) return console.log(c.dim("no matches"));
      for (const i of items) {
        const st = i.status === "trusted" ? c.green(i.status) : i.status === "demoted" ? c.red(i.status) : c.yellow(i.status);
        console.log(`${c.bold(i.name.padEnd(28))} ${st.padEnd(tty ? 18 : 9)} health ${String(i.health_score ?? "–").padStart(3)} · ${i.runs} runs  ${c.dim(i.description)}`);
      }
      return;
    }
    case "pull": {
      if (!pos[0]) throw new Error("usage: forge pull <name>");
      const yaml = await hub<string>(`/api/procedures/${encodeURIComponent(pos[0])}/yaml`);
      const dir = (flags.dir as string) ?? join(homedir(), "browserops", "procedures");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${pos[0]}.yaml`);
      writeFileSync(file, yaml);
      console.log(`wrote ${file}\n${c.dim("BrowserOps agents can now find it with procedures_search (enable: browserops feature enable procedures)")}`);
      return;
    }
    case "run": {
      if (!pos[0]) throw new Error("usage: forge run <name|file.yaml> --input k=v");
      const { launch, executeProcedure } = await import("@forge/runner");
      const proc = await loadProcedure(pos[0]);
      const s = await launch({ headless: !flags.headed });
      try {
        console.log(`${c.bold(proc.name)} v${proc.meta?.version ?? 1}`);
        const res = await executeProcedure(s.page, proc, { inputs, strict: !!flags.strict, log: console.log });
        console.log(res.completed ? c.green(`✓ completed in ${res.duration_ms}ms`) : c.red(`✗ ${res.status} at ${res.divergence?.step}: ${res.divergence?.reason}`));
        if (!flags["no-report"] && !existsSync(pos[0])) {
          const r = await hub<{ status: string; demote_reason?: string }>(`/api/procedures/${proc.name}/runs`, {
            method: "POST",
            body: JSON.stringify({ ...res, version: proc.meta?.version, environment: flags.env ?? "cli", runner: "forge-cli" }),
          });
          console.log(c.dim(`reported to hub → ${r.status}${r.demote_reason ? ` (${r.demote_reason})` : ""}`));
        }
        process.exitCode = res.completed ? 0 : 1;
      } finally {
        await s.close();
      }
      return;
    }
    case "heal": {
      if (!pos[0]) throw new Error("usage: forge heal <name> --input k=v");
      const { launch, healProcedure } = await import("@forge/runner");
      const proc = await loadProcedure(pos[0]);
      const s = await launch({ headless: !flags.headed });
      try {
        const { procedure, patches, run } = await healProcedure(s.page, proc, inputs, (flags.steps as string | undefined)?.split(","));
        if (!patches.length) return console.log(run.completed ? c.green("nothing to heal — every locator resolved directly") : c.red(`run halted: ${run.divergence?.reason}`));
        for (const p of patches) console.log(`${c.cyan(p.step)}: ${describeLocator(p.before)} → ${c.green(describeLocator(p.after))}`);
        const out = (flags.out as string) ?? `${procedure.name}.v${procedure.meta?.version}.yaml`;
        writeFileSync(out, toYaml(procedure));
        console.log(`wrote ${out}`);
        if (flags.publish) {
          const r = await hub<{ version: number }>("/api/procedures", {
            method: "POST",
            body: JSON.stringify({ yaml: toYaml(procedure), author: "forge-heal", changelog: patches.map((p) => `${p.step}: ${p.why}`).join("\n") }),
          });
          console.log(`published v${r.version} → ${c.yellow("draft")}`);
        }
      } finally {
        await s.close();
      }
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^[\s\S]*?\/\*\*\n/, "").replace(/^ \* ?/gm, ""));
  }
}

main().catch((e) => {
  console.error(c.red(`forge: ${(e as Error).message}`));
  const body = (e as { body?: { lint?: { severity: string; rule: string; message: string }[] } }).body;
  for (const f of body?.lint ?? []) if (f.severity === "error") console.error(`  ${f.rule}: ${f.message}`);
  process.exit(1);
});
