import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { compileTrajectory, type Procedure } from "@forge/core";
import { RecordingTools, executeProcedure, healProcedure, launch, type Session } from "../src/index.ts";
import { createApp } from "../../../apps/hub/server/app.ts";
import { Store } from "../../../apps/hub/server/store.ts";

let server: Server;
let session: Session;
let base = "";
let proc: Procedure;

const setLayout = async (v: "v1" | "v2") => {
  await session.context.clearCookies();
  if (v === "v2") await session.context.addCookies([{ name: "relay_layout", value: "v2", url: base }]);
};
const lastSent = async () => (await (await fetch(`${base}/demo/api/sent`)).json())[0];

beforeAll(async () => {
  server = createApp(new Store(":memory:")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  session = await launch();
});
afterAll(async () => {
  await session?.close();
  server?.close();
});

describe("record → compile → replay (real browser)", () => {
  it("records a noisy run and compiles it to a clean procedure", async () => {
    await setLayout("v1");
    const t = new RecordingTools(session.page, { task: "send an email", app: "relay" });
    await t.browser_navigate(`${base}/demo/`);
    await t.browser_read();
    await t.browser_click(t.ref("button", "Refresh")); // real zero-effect click
    await t.browser_click(t.ref("button", "Compose"));
    await t.browser_read();
    await t.browser_type(t.ref("textbox", "To"), "me@relay.test");
    await t.browser_type(t.ref("textbox", "Subject"), "hello");
    await t.browser_type(t.ref("textbox", "Message body"), "body");
    await t.browser_click(t.ref("button", "Send"));
    await t.browser_read();

    const res = compileTrajectory(t.trajectory(), { name: "relay.send_email" });
    expect(res.schema.valid).toBe(true);
    expect(res.stats.dropped.no_page_effect).toBe(1);
    expect(res.procedure.steps.map((s) => s.do)).toEqual(["navigate", "wait", "click", "type", "type", "type", "click"]);
    expect(res.procedure.verify?.text_visible).toBe("Message sent:");
    proc = res.procedure;
  });

  it("replays deterministically with new inputs and hits the goal", async () => {
    const r = await executeProcedure(session.page, proc, { inputs: { to: "me@relay.test", subject: "replayed", body: "x" }, strict: true });
    expect(r.status).toBe("completed");
    expect(r.verify_ok).toBe(true);
    expect(Object.values(r.resolutions).every((x) => !x.used_relocate)).toBe(true);
    expect((await lastSent()).subject).toBe("replayed");
  });

  it("halts on a missing required input", async () => {
    const r = await executeProcedure(session.page, proc, { inputs: { to: "x" } });
    expect(r.status).toBe("halted");
    expect(r.divergence?.reason).toMatch(/missing required input/);
  });

  it("survives a redesign via relocation, and reports it", async () => {
    await setLayout("v2");
    const r = await executeProcedure(session.page, proc, { inputs: { to: "me@relay.test", subject: "after redesign", body: "x" }, strict: true });
    expect(r.status).toBe("completed");
    expect(r.resolutions.click_send.used_relocate).toBe(true);
    expect(r.resolutions.click_compose.used_relocate).toBe(false); // tier-1 testid survived the copy change
    expect((await lastSent()).subject).toBe("after redesign");
  });

  it("heals the drifted locator from the live page", async () => {
    const { procedure, patches } = await healProcedure(session.page, proc, { to: "me@relay.test", subject: "heal", body: "x" });
    expect(patches.map((p) => p.step)).toEqual(["click_send"]);
    expect(procedure.steps.find((s) => s.id === "click_send")?.locator).toEqual({ role: "button", name: "/^Send message$/i" });
    expect(procedure.meta?.version).toBe(2);
    const r = await executeProcedure(session.page, procedure, { inputs: { to: "me@relay.test", subject: "healed", body: "x" }, strict: true });
    expect(r.resolutions.click_send.used_relocate).toBe(false);
  });

  it("refuses to dispatch onto a forbidden control, even after relocation", async () => {
    await setLayout("v1");
    const evil: Procedure = {
      ...proc,
      steps: [proc.steps[0], { id: "click_target", do: "click", locator: { role: "button", name: "/^Delete$/i" } }],
    };
    const r = await executeProcedure(session.page, evil, { inputs: { to: "a", subject: "b", body: "c" } });
    expect(r.status).toBe("forbidden");
  });
});
