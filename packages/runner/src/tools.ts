import type { Page } from "playwright";
import type { SnapshotNode, ToolCall, ToolResult, Trajectory } from "@forge/core";
import { snapshotPage, refSelector } from "./snapshot.ts";
import { measure } from "./effects.ts";

/**
 * A BrowserOps-compatible browser_* tool surface over Playwright that records
 * every call into a trajectory. It lets Forge produce real trajectories (real
 * DOM, real effects, real network) for demos and tests without a live
 * BrowserOps install. With BrowserOps you'd capture the MCP transcript
 * instead; the compiler reads both.
 */
export class RecordingTools {
  readonly calls: ToolCall[] = [];
  private last: SnapshotNode[] = [];
  constructor(
    readonly page: Page,
    readonly meta: { task?: string; app?: string } = {},
  ) {}

  private async log(tool: string, args: Record<string, unknown>, fn: () => Promise<ToolResult>): Promise<ToolResult> {
    const ts = new Date().toISOString();
    const t0 = Date.now();
    let result: ToolResult;
    try {
      result = await fn();
    } catch (e) {
      result = { ok: false, error: (e as Error).message.split("\n")[0].slice(0, 200) };
    }
    this.calls.push({ seq: this.calls.length, ts, tool, args, result, duration_ms: Date.now() - t0 });
    return result;
  }

  trajectory(): Trajectory {
    return { task: this.meta.task, app: this.meta.app, started: this.calls[0]?.ts, calls: this.calls };
  }

  browser_list_tabs() {
    return this.log("browser_list_tabs", {}, async () => ({ ok: true, tabs: [{ tab_id: 1, url: this.page.url(), title: await this.page.title(), active: true }] }));
  }

  browser_navigate(url: string) {
    return this.log("browser_navigate", { tab_id: 1, url }, async () => {
      const m = await measure(this.page, async () => {
        await this.page.goto(url, { waitUntil: "domcontentloaded" });
      });
      return { ok: true, url: this.page.url(), page_effect: m.page_effect, effect: m.effect };
    });
  }

  browser_read() {
    return this.log("browser_read", { tab_id: 1, mode: "a11y_tree", augment: true }, async () => {
      this.last = await snapshotPage(this.page);
      return { ok: true, url: this.page.url(), snapshot: this.last };
    });
  }

  browser_screenshot() {
    return this.log("browser_screenshot", { tab_id: 1 }, async () => {
      const buf = await this.page.screenshot();
      // Image bytes are what makes screenshots expensive for agents; record the size, not the pixels.
      return { ok: true, bytes: buf.length, note: "image omitted from trajectory" };
    });
  }

  browser_quick_read(query: string) {
    return this.log("browser_quick_read", { tab_id: 1, query }, async () => {
      this.last = await snapshotPage(this.page);
      const q = query.toLowerCase();
      return { ok: true, matches: this.last.filter((n) => n.name.toLowerCase().includes(q)) };
    });
  }

  /** Find a ref in the last snapshot by role + name, the way an agent reads one off browser_read output. */
  ref(role: string, name: string | RegExp): number {
    const n = this.last.find((x) => x.role === role && (typeof name === "string" ? x.name === name : name.test(x.name)));
    if (!n) throw new Error(`no ${role} "${String(name)}" in last snapshot`);
    return n.ref;
  }

  browser_click(ref: number) {
    return this.log("browser_click", { tab_id: 1, ref }, async () => {
      const el = this.page.locator(refSelector(ref));
      if ((await el.count()) === 0) return { ok: false, error: `ref ${ref} not found (stale ref?)` };
      const m = await measure(this.page, () => el.first().click({ timeout: 3000 }));
      return { ok: true, clicked: true, page_effect: m.page_effect, effect: m.effect };
    });
  }

  browser_type(ref: number, text: string) {
    return this.log("browser_type", { tab_id: 1, ref, text, clear_mode: "auto" }, async () => {
      const el = this.page.locator(refSelector(ref));
      if ((await el.count()) === 0) return { ok: false, error: `ref ${ref} not found (stale ref?)` };
      const m = await measure(this.page, () => el.first().fill(text, { timeout: 3000 }), 120);
      // fill() changes .value (a property, not an attribute) — surface it as a value change like CDP input does.
      m.page_effect.dom.attr_changes += 1;
      if (m.effect.mutations) m.effect.mutations.attr += 1;
      return { ok: true, typed: text.length, page_effect: m.page_effect, effect: m.effect };
    });
  }

  browser_press(key: string) {
    return this.log("browser_press", { tab_id: 1, key }, async () => {
      const m = await measure(this.page, () => this.page.keyboard.press(key));
      return { ok: true, page_effect: m.page_effect, effect: m.effect };
    });
  }
}
