import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { compileTrajectory, type ResolutionRecord } from "@forge/core";
import { createApp } from "../server/app.ts";
import { Store } from "../server/store.ts";
import { gmailTrajectory } from "../../../packages/core/test/fixtures.ts";

let server: Server;
let base = "";
const post = async (path: string, body: unknown) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

beforeAll(async () => {
  server = createApp(new Store(":memory:")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const yaml = compileTrajectory(gmailTrajectory()).yaml;
const clean: Record<string, ResolutionRecord> = { click_send: { match_count: 1, used_relocate: false, matched_ref: 13, tier: 2 } };
const relocated: Record<string, ResolutionRecord> = { click_send: { match_count: 1, used_relocate: true, matched_ref: 13, tier: 2 } };

describe("Forge Hub API", () => {
  it("rejects procedures with schema/lint errors", async () => {
    const r = await post("/api/procedures", { yaml: "schema_version: 1\nname: Bad Name\nkind: leaf\nsteps: []\n" });
    expect(r.status).toBe(422);
    expect(r.body.schema.valid).toBe(false);
  });

  it("ignores client-claimed trust: every publish starts as draft", async () => {
    const r = await post("/api/procedures", { yaml: yaml.replace("status: draft", "status: trusted") });
    expect(r.status).toBe(201);
    const d = await (await fetch(`${base}/api/procedures/${r.body.name}`)).json();
    expect(d.status).toBe("draft");
  });

  it("promotes to trusted only after 3 consecutive clean strict runs", async () => {
    const name = "acmemail.send_email";
    const run = (resolutions = clean, strict = true) => post(`/api/procedures/${name}/runs`, { completed: true, strict, duration_ms: 900, resolutions });
    expect((await run()).body.status).toBe("draft");
    expect((await run(clean, false)).body.status).toBe("draft"); // non-strict run breaks the streak
    expect((await run()).body.status).toBe("draft");
    expect((await run()).body.status).toBe("draft");
    expect((await run()).body.status).toBe("trusted");
  });

  it("demotes on drift using BrowserOps thresholds, with a reason", async () => {
    const name = "acmemail.send_email";
    let last;
    for (let i = 0; i < 4; i++) last = await post(`/api/procedures/${name}/runs`, { completed: true, strict: true, duration_ms: 3000, resolutions: relocated });
    // 5 clean + 4 relocated = 4/9 = 44% > 40%
    expect(last!.body.status).toBe("demoted");
    expect(last!.body.demote_reason).toMatch(/click_send: relocate rate 44% > 40% over 9 runs/);
  });

  it("a new version resets health and trust", async () => {
    const r = await post("/api/procedures", { yaml, changelog: "healed" });
    expect(r.body.version).toBe(2);
    const d = await (await fetch(`${base}/api/procedures/acmemail.send_email`)).json();
    expect(d.status).toBe("draft");
    expect(d.health.steps).toEqual({});
  });

  it("searches with the BrowserOps tokenizer and exports installable YAML", async () => {
    const hits = await (await fetch(`${base}/api/procedures?q=sending%20emails`)).json();
    expect(hits[0].name).toBe("acmemail.send_email");
    const y = await (await fetch(`${base}/api/procedures/acmemail.send_email/yaml`)).text();
    expect(y).toContain("schema_version: 1");
    expect(y).toContain("version: 2");
  });

  it("compiles trajectories over HTTP", async () => {
    const lines = gmailTrajectory().calls.map((c) => JSON.stringify({ type: "tool_call", ...c })).join("\n");
    const r = await post("/api/compile", { trajectory: lines });
    expect(r.status).toBe(200);
    expect(r.body.schema.valid).toBe(true);
  });
});
