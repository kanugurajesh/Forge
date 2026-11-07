import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  compileTrajectory,
  emptyHealth,
  healthScore,
  lintProcedure,
  parseTrajectory,
  proposeLocator,
  recordResolution,
  resolveLocator,
  scoreProcedure,
  serializeTrajectory,
  shouldDemote,
  tokenize,
  validateProcedure,
  classifyLocator,
  forbiddenOverlaps,
  isExclusionName,
  type Procedure,
} from "../src/index.ts";
import { composeSnapshot, gmailTrajectory } from "./fixtures.ts";

describe("compiler", () => {
  const res = compileTrajectory(gmailTrajectory(), { now: "2026-11-06T00:00:00Z" });
  const p = res.procedure;
  const ids = p.steps.map((s) => s.id);

  it("emits a procedure that passes the BrowserOps v1 schema", () => {
    expect(res.schema.issues).toEqual([]);
    expect(res.schema.valid).toBe(true);
    expect(p.meta?.status).toBe("draft");
  });

  it("drops observation, failed, zero-effect, superseded and redundant calls", () => {
    expect(res.stats.dropped.observation).toBe(5);
    expect(res.stats.dropped.failed).toBe(1);
    expect(res.stats.dropped.no_page_effect).toBe(1);
    expect(res.stats.dropped.superseded).toBe(1);
    expect(res.stats.dropped.redundant_navigation).toBe(1);
    expect(ids).toEqual(["open_app", "wait_compose", "click_compose", "fill_to", "fill_subject", "fill_message_body", "click_send"]);
  });

  it("lifts typed literals into inputs, keeping samples out of the YAML", () => {
    expect(Object.keys(p.inputs ?? {})).toEqual(["to", "subject", "message_body"]);
    expect(res.samples.subject).toBe("Q3 numbers");
    expect(res.yaml).not.toContain("dana@acme.test");
    expect(p.steps.find((s) => s.id === "fill_subject")?.with?.text).toBe("{{subject}}");
  });

  it("prefers tier-1 locators and anchors names to avoid 'Schedule send'", () => {
    const compose = p.steps.find((s) => s.id === "click_compose")!.locator!;
    expect(compose.data_testid).toBe("compose");
    expect(compose.role).toBe("button");
    expect(isExclusionName(compose.name)).toBe(true); // guard-only constraint, not copy
    expect(classifyLocator(compose)).toBe(1);
    for (const f of p.forbidden!.locators!) expect(forbiddenOverlaps(f, compose)).toBe(false);
    expect(p.steps.find((s) => s.id === "fill_to")?.locator).toEqual({ attr: { name: "name", value: "to" }, role: "textbox" });
    const send = p.steps.find((s) => s.id === "click_send")!;
    expect(send.locator).toEqual({ role: "button", name: "/^Send$/i" });
    expect(resolveLocator(composeSnapshot, send.locator!)).toHaveLength(1);
    expect(resolveLocator(composeSnapshot, { role: "button", name: "send" })).toHaveLength(2);
  });

  it("derives expect predicates from observed effects", () => {
    expect(p.steps.find((s) => s.id === "click_compose")?.expect?.new_dialog).toBe("/^New message$/i");
    expect(p.steps.find((s) => s.id === "click_send")?.expect?.network_endpoint_seen).toBe("/api/send");
  });

  it("infers side effects, destructive inputs, forbidden controls and verify", () => {
    expect(p.side_effects).toEqual(["send_message"]);
    expect(p.inputs?.subject.destructive).toBe(true);
    const names = (p.forbidden?.locators ?? []).map((l) => l.name);
    expect(names).toEqual(expect.arrayContaining(["/^Delete$/i", "/^Discard draft$/i", "/^Archive$/i"]));
    expect(p.verify?.network_endpoint_seen).toBe("/api/send");
    expect(p.verify?.text_visible).toBe("Message sent:");
  });

  it("names the procedure from the task without eating words that merely overlap the app name", () => {
    expect(p.name).toBe("acmemail.send_email");
  });

  it("has no lint errors", () => {
    expect(res.lint.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("round-trips through the JSONL format", () => {
    const again = compileTrajectory(parseTrajectory(serializeTrajectory(gmailTrajectory())), { now: "2026-11-06T00:00:00Z" });
    expect(again.yaml).toBe(res.yaml);
  });
});

describe("JSON-RPC adapter", () => {
  it("parses MCP tools/call transcripts with text a11y trees", () => {
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_read", arguments: {} } },
      { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '- button "Compose" [ref=4]\n- link "Inbox" [ref=5]' }] } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_click", arguments: { ref: 4 } } },
      { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ clicked: true }) }] } },
    ];
    const t = parseTrajectory(lines.map((l) => JSON.stringify(l)).join("\n"));
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0].result?.snapshot?.[0]).toMatchObject({ role: "button", name: "Compose", ref: 4 });
    const r = compileTrajectory(t);
    expect(r.procedure.steps[0].locator).toEqual({ role: "button", name: "/^Compose$/i" });
  });
});

describe("locator proposer", () => {
  it("falls back to a flagged tier-3 nth locator when nothing disambiguates", () => {
    const snap = [
      { ref: 1, role: "button", name: "Edit" },
      { ref: 2, role: "button", name: "Edit" },
    ];
    const prop = proposeLocator(snap[1], snap);
    expect(prop).toMatchObject({ tier: 3, fragile: true, locator: { role: "button", name: "/^Edit$/i", nth: 1 } });
  });
});

describe("drift health (BrowserOps thresholds)", () => {
  const rec = (relocate: boolean, ref = 7) => ({ match_count: 1, used_relocate: relocate, matched_ref: ref, tier: 2 as const });
  it("demotes when relocate rate > 40% over >= 5 runs", () => {
    let h = emptyHealth("t");
    for (const r of [false, false, true, true, true]) h = recordResolution(h, "click_send", rec(r), "t");
    expect(h.steps.click_send).toMatchObject({ runs: 5, relocates: 3 });
    expect(shouldDemote(h).demote).toBe(true);
  });
  it("does not demote at exactly 40%", () => {
    let h = emptyHealth("t");
    for (const r of [false, false, false, true, true]) h = recordResolution(h, "s", rec(r), "t");
    expect(shouldDemote(h).demote).toBe(false);
    expect(healthScore(h)).toBeGreaterThan(50);
  });
  it("demotes when the resolved target changes after >= 3 runs", () => {
    let h = emptyHealth("t");
    h = recordResolution(h, "s", rec(false, 7), "t");
    h = recordResolution(h, "s", rec(false, 7), "t");
    h = recordResolution(h, "s", rec(false, 9), "t");
    expect(h.steps.s.target_changed).toBe(1);
    expect(shouldDemote(h).reasons[0].reason).toMatch(/target changed/);
  });
});

describe("linter", () => {
  it("catches the teach-skill failure modes", () => {
    const bad = {
      schema_version: 1,
      name: "x.bad",
      description: "bad",
      kind: "leaf",
      side_effects: ["send_message"],
      steps: [
        { id: "a", do: "observe" },
        { id: "b", do: "click", locator: { role: "button", name: "send" }, fallback: { strategy: "llm" } },
        { id: "c", do: "type", locator: { nth: 2 }, with: { text: "{{body}}", ref: 12 } },
      ],
    } as unknown as Procedure;
    const rules = lintProcedure(bad).map((f) => f.rule);
    expect(rules).toEqual(
      expect.arrayContaining(["llm-needs-expect", "undeclared-input", "no-baked-ref", "unanchored-name", "fragile-locator", "manual-prime", "missing-forbidden", "missing-verify"]),
    );
  });
  it("rejects schema-invalid documents", () => {
    expect(validateProcedure({ schema_version: 2, name: "Bad Name", kind: "leaf", steps: [] }).valid).toBe(false);
  });
});

describe("search", () => {
  it("tokenizes like BrowserOps procedures_search", () => {
    expect(tokenize("Sending the emails to my boss")).toEqual(["send", "email", "bos"]);
  });
  it("ranks name/domain hits", () => {
    const p = { name: "gmail.send_email", description: "Send an email", domain: "gmail" };
    expect(scoreProcedure("gmail send email", p)).toBeGreaterThan(0.9);
    expect(scoreProcedure("linear triage", p)).toBe(0);
  });
});

describe("live BrowserOps compatibility", () => {
  // Exported from a real Claude Code session driving BrowserOps 0.0.11 against the Relay demo.
  const live = compileTrajectory(
    parseTrajectory(readFileSync(new URL("../../../fixtures/relay-send-email.live.mcp.jsonl", import.meta.url), "utf8")),
    { name: "relay.send_email", now: "2026-11-07T00:00:00Z" },
  );

  it("reads browser_read {content, refs[]} and keeps zero-mutation actions", () => {
    expect(live.procedure.steps.map((s) => s.id)).toEqual([
      "open_app", "wait_compose", "click_compose", "fill_to", "fill_subject", "fill_message_body", "click_send",
    ]);
    expect(live.procedure.steps.find((s) => s.id === "fill_to")?.locator).toEqual({ attr: { name: "name", value: "to" }, role: "textbox" });
    expect(live.samples).toEqual({ to: "priya@relay.dev", subject: "Launch checklist", body: "Looks good, ship it Friday." });
  });

  it("emits nothing the runtime's static forbidden guard would refuse", () => {
    expect(live.lint.filter((f) => f.severity === "error")).toEqual([]);
    for (const s of live.procedure.steps)
      for (const f of live.procedure.forbidden!.locators!) if (s.locator) expect(forbiddenOverlaps(f, s.locator)).toBe(false);
  });

  it("makes a dialog submit prove the dialog closed (a validation toast also adds DOM)", () => {
    expect(live.procedure.steps.find((s) => s.id === "click_send")?.expect).toEqual({ text_invisible: "/^Send$/m", timeout_ms: 5000 });
    expect(live.procedure.steps[0].with).toMatchObject({ wait_for_load: false });
  });
});

describe("forbidden guard port", () => {
  const archive = { role: "button", name: "/^Archive$/i" };
  it("matches BrowserOps: a descriptor without role+name cannot be proven safe", () => {
    expect(forbiddenOverlaps(archive, { data_testid: "compose-button" })).toBe(true);
    expect(forbiddenOverlaps(archive, { data_testid: "compose-button", role: "button" })).toBe(true);
    expect(forbiddenOverlaps(archive, { aria_label: "Message body", role: "textbox" })).toBe(false);
    expect(forbiddenOverlaps(archive, { role: "button", name: "/^Send$/i" })).toBe(false);
    expect(forbiddenOverlaps(archive, { role: "button", name: "/^Archive$/i" })).toBe(true);
  });
});
