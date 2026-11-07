/**
 * End-to-end Forge demo against a real browser:
 *
 *   1. RECORD   a noisy "agent" run through the browser_* tool surface (real DOM, real effects)
 *   2. COMPILE  the trajectory into a BrowserOps v1 procedure (schema-valid, linted)
 *   3. PUBLISH  to Forge Hub as a draft
 *   4. VERIFY   3 strict runs + an external goal predicate each time → Hub promotes to trusted
 *   5. DRIFT    ship the app "redesign" (v2); runs keep completing via relocation, but drift
 *              health crosses BrowserOps' threshold → Hub demotes it
 *   6. HEAL     re-propose locators from the live page → publish v2 → re-verify → trusted again
 *
 * Usage:  npm run demo            (headless, then exits; data persists for `npm run hub`)
 *         npm run demo -- --headed --serve
 *         npm run demo -- --no-heal      (leave relay.send_email demoted to see the drift UI)
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileTrajectory, describeLocator, serializeTrajectory, type Procedure } from "@forge/core";
import { RecordingTools, executeProcedure, healProcedure, launch, type RunResult } from "@forge/runner";
import { createApp } from "../apps/hub/server/app.ts";
import { Store } from "../apps/hub/server/store.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.PORT ?? 4317);
const BASE = `http://127.0.0.1:${PORT}`;
const DEMO = `${BASE}/demo/`;

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
const h = (n: number, s: string) => console.log(`\n${c.bold(c.cyan(`[${n}]`))} ${c.bold(s)}`);

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, { headers: { "content-type": "application/json" }, ...init });
  const body = await r.json();
  if (!r.ok) throw new Error(`${path} → ${r.status} ${JSON.stringify(body).slice(0, 400)}`);
  return body as T;
}

async function main() {
  const dataDir = join(ROOT, ".forge-data");
  if (!args.has("--keep")) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  const store = new Store(join(dataDir, "hub.db"));
  const server = createApp(store).listen(PORT, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  console.log(c.dim(`Forge Hub on ${BASE}  ·  demo app ${DEMO}`));

  const session = await launch({ headless: !args.has("--headed") });
  const { page, context } = session;
  const setLayout = async (v: "v1" | "v2") => {
    await context.clearCookies();
    if (v === "v2") await context.addCookies([{ name: "relay_layout", value: "v2", url: BASE }]);
  };

  try {
    // ------------------------------------------------------------------ 1. RECORD
    h(1, "Record a noisy agent run (send an email in Relay)");
    await setLayout("v1");
    const t = new RecordingTools(page, { task: "send an email in Relay mail", app: "relay" });
    await t.browser_list_tabs();
    await t.browser_navigate(`${BASE}/demo`); // lands, then the agent "corrects" the URL
    await t.browser_navigate(DEMO);
    await t.browser_read();
    await t.browser_screenshot();
    await t.browser_click(t.ref("button", "Refresh")); // agent pokes Refresh: dispatched, nothing happens
    await t.browser_click(424242); // stale ref from an earlier read
    await t.browser_click(t.ref("button", "Compose"));
    await t.browser_read();
    await t.browser_type(t.ref("textbox", "To"), "me@relay.test");
    await t.browser_type(t.ref("textbox", "Subject"), "Weekly upate");
    await t.browser_quick_read("Subject"); // agent double-checks, spots the typo
    await t.browser_type(t.ref("textbox", "Subject"), "Weekly update");
    await t.browser_type(t.ref("textbox", "Message body"), "Shipped billing upgrade. Next: Linear triage.");
    await t.browser_screenshot();
    await t.browser_click(t.ref("button", "Send"));
    await t.browser_read();
    const sendTraj = t.trajectory();
    console.log(`   recorded ${sendTraj.calls.length} tool calls`);

    const t2 = new RecordingTools(page, { task: "search mail in Relay", app: "relay" });
    await t2.browser_navigate(DEMO);
    await t2.browser_read();
    await t2.browser_type(t2.ref("searchbox", "Search mail"), "invoice");
    await t2.browser_press("Enter");
    await t2.browser_screenshot();
    await t2.browser_read();
    const searchTraj = t2.trajectory();

    mkdirSync(join(ROOT, "fixtures"), { recursive: true });
    writeFileSync(join(ROOT, "fixtures", "relay-send-email.trajectory.jsonl"), serializeTrajectory(sendTraj));
    writeFileSync(join(ROOT, "fixtures", "relay-search.trajectory.jsonl"), serializeTrajectory(searchTraj));

    // ------------------------------------------------------------------ 2. COMPILE
    h(2, "Compile trajectory → procedure");
    const compiled = compileTrajectory(sendTraj, { name: "relay.send_email" });
    const s = compiled.stats;
    for (const e of compiled.events) {
      const tag = e.decision === "kept" ? c.green("keep") : c.dim(`drop:${e.reason}`);
      console.log(`   ${String(e.seq).padStart(2)} ${e.tool.padEnd(20)} ${tag.padEnd(30)} ${c.dim(e.detail)}`);
    }
    console.log(`   ${s.recorded_calls} calls → ${c.bold(String(s.kept_steps))} steps · tiers ${JSON.stringify(compiled.tiers)} · schema ${compiled.schema.valid ? c.green("valid") : c.red("INVALID")} · lint errors ${compiled.lint.filter((l) => l.severity === "error").length}`);
    console.log(`   inputs: ${Object.keys(compiled.procedure.inputs ?? {}).join(", ")} · side_effects: ${compiled.procedure.side_effects?.join(", ")} · forbidden: ${(compiled.procedure.forbidden?.locators ?? []).map(describeLocator).join(" | ")}`);
    const compiledSearch = compileTrajectory(searchTraj, { name: "relay.search_mail" });
    writeFileSync(join(ROOT, "fixtures", "relay.send_email.yaml"), compiled.yaml);

    // ------------------------------------------------------------------ 3. PUBLISH
    h(3, "Publish to Forge Hub");
    const compileMeta = (r: typeof compiled) => ({ ...r.stats, tiers: r.tiers, events: r.events, warnings: r.warnings });
    for (const r of [compiled, compiledSearch]) {
      const pub = await api<{ name: string; version: number }>("/api/procedures", {
        method: "POST",
        body: JSON.stringify({ yaml: r.yaml, author: "forge-demo", compile: compileMeta(r), changelog: "Compiled from a recorded agent run" }),
      });
      console.log(`   ${pub.name} v${pub.version} → ${c.yellow("draft")}`);
    }

    // ------------------------------------------------------------------ 4. VERIFY
    const runAndReport = async (proc: Procedure, inputs: Record<string, string>, env: string, check?: () => Promise<boolean>) => {
      const res: RunResult = await executeProcedure(page, proc, { inputs, strict: true });
      let predicate = true;
      if (check && res.completed) predicate = await check();
      const report = { ...res, completed: res.completed && predicate, environment: env, runner: "forge-runner/playwright" };
      const hub = await api<{ status: string; demote_reason?: string; health_score: number }>(`/api/procedures/${proc.name}/runs`, {
        method: "POST",
        body: JSON.stringify({ ...report, version: proc.meta?.version }),
      });
      const relocated = res.steps.filter((x) => x.relocated).map((x) => `${x.id}→${x.relocated_to}`);
      const status = hub.status === "trusted" ? c.green(hub.status) : hub.status === "demoted" ? c.red(hub.status) : c.yellow(hub.status);
      console.log(
        `   ${env} ${res.completed ? c.green("✓ completed") : c.red(`✗ ${res.status}`)} in ${String(res.duration_ms).padStart(4)}ms · predicate ${predicate ? "✓" : c.red("✗")} · health ${hub.health_score ?? "–"} · hub: ${status}` +
          (relocated.length ? c.yellow(`  relocated ${relocated.join(", ")}`) : "") +
          (hub.demote_reason && hub.status === "demoted" ? c.red(`\n      demote_reason: ${hub.demote_reason}`) : "") +
          (res.divergence ? c.red(`\n      divergence @ ${res.divergence.step}: ${res.divergence.reason}`) : ""),
      );
      return { res, hub };
    };
    const sentHas = (subject: string) => async () => {
      const sent = await (await fetch(`${BASE}/demo/api/sent`)).json();
      return sent[0]?.subject === subject;
    };

    h(4, "Verify: 3 strict runs + external goal predicate (send-to-self) → trust");
    const fetchProc = async (name: string) => (await api<{ procedure: Procedure }>(`/api/procedures/${name}`)).procedure;
    let sendProc = await fetchProc("relay.send_email");
    for (let i = 1; i <= 3; i++) {
      const subject = `Forge verify #${i} ${Date.now() % 10000}`;
      await runAndReport(sendProc, { to: "me@relay.test", subject, body: "verification run" }, "app@v1-layout", sentHas(subject));
    }
    const searchProc = await fetchProc("relay.search_mail");
    for (const q of ["invoice", "linear", "launch"]) await runAndReport(searchProc, { search_mail: q }, "app@v1-layout");

    // ------------------------------------------------------------------ 5. DRIFT
    h(5, "The app ships a redesign (v2 layout, same URL) — keep running the trusted procedure");
    await setLayout("v2");
    for (let i = 1; i <= 3; i++) {
      const subject = `Post-redesign #${i} ${Date.now() % 10000}`;
      await runAndReport(sendProc, { to: "me@relay.test", subject, body: "drift run" }, "app@v2-redesign", sentHas(subject));
    }

    // ------------------------------------------------------------------ 6. HEAL
    if (!args.has("--no-heal")) {
      h(6, "Heal: re-propose drifted locators from the live page → new version → re-verify");
      const healSubject = `Heal probe ${Date.now() % 10000}`;
      const healed = await healProcedure(page, sendProc, { to: "me@relay.test", subject: healSubject, body: "heal" });
      for (const p of healed.patches) console.log(`   patch ${p.step}: ${describeLocator(p.before)}  →  ${c.green(describeLocator(p.after))}  (tier ${p.tier_before}→${p.tier_after})`);
      const { toYaml } = await import("@forge/core");
      const pub2 = await api<{ version: number }>("/api/procedures", {
        method: "POST",
        body: JSON.stringify({ yaml: toYaml(healed.procedure), author: "forge-heal", changelog: healed.patches.map((p) => `${p.step}: ${p.why}`).join("\n") }),
      });
      console.log(`   published relay.send_email v${pub2.version} → ${c.yellow("draft")} (trust must be re-earned)`);
      sendProc = await fetchProc("relay.send_email");
      for (let i = 1; i <= 3; i++) {
        const subject = `Healed #${i} ${Date.now() % 10000}`;
        await runAndReport(sendProc, { to: "me@relay.test", subject, body: "healed run" }, "app@v2-redesign", sentHas(subject));
      }
    }

    const stats = await api<Record<string, number>>("/api/stats");
    h(7, "Hub totals");
    console.log(`   ${JSON.stringify(stats)}`);
    console.log(c.dim(`\n   Recorded agent run: ${s.recorded_calls} tool calls, ~${s.recorded_tokens.toLocaleString()} tokens, ${(s.recorded_ms / 1000).toFixed(1)}s`));
    console.log(c.dim(`   Compiled replay:    ${s.replay_tool_calls} deterministic steps, 0 LLM tokens`));
  } finally {
    await session.close();
    if (args.has("--serve")) {
      console.log(`\n${c.bold("Hub is live →")} ${BASE}   (Ctrl+C to stop)`);
    } else {
      server.close();
      store.db.close();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
