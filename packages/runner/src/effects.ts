import type { Page, Request } from "playwright";
import type { Effect, PageEffect, SnapshotNode } from "@forge/core";

/**
 * Measures what an action did to the page during a short observation window,
 * producing BrowserOps-shaped `page_effect` + `effect` envelopes. This is the
 * "observation contract": a dispatched click is not success, a page reaction is.
 */
export interface Measured {
  page_effect: PageEffect;
  effect: Effect;
  endpoints: string[];
}

const WINDOW_MS = 350;

export async function measure(page: Page, action: () => Promise<void>, windowMs = WINDOW_MS): Promise<Measured> {
  const endpoints: string[] = [];
  let started = 0;
  let completed = 0;
  let failed = 0;
  const onReq = (r: Request) => {
    if (["document", "fetch", "xhr"].includes(r.resourceType())) {
      started++;
      endpoints.push(`${r.method()} ${r.url()}`);
    }
  };
  const onDone = () => completed++;
  const onFail = () => {
    completed++;
    failed++;
  };
  page.on("request", onReq);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onFail);

  const before = await page
    .evaluate(() => {
      const w = window as unknown as { __forgeObs?: MutationObserver; __forgeCounts?: Record<string, number> };
      w.__forgeObs?.disconnect();
      const c = { added: 0, removed: 0, attr: 0, char: 0 };
      w.__forgeCounts = c;
      w.__forgeObs = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "childList") {
            c.added += m.addedNodes.length;
            c.removed += m.removedNodes.length;
          } else if (m.type === "attributes" && m.attributeName !== "data-forge-ref") c.attr++;
          else if (m.type === "characterData") c.char++;
        }
      });
      w.__forgeObs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      const dialogs = Array.from(document.querySelectorAll("dialog[open],[role=dialog]")).map((d) => d.getAttribute("aria-label") ?? "");
      const ae = document.activeElement;
      return { url: location.href, dialogs, focus: ae ? `${ae.tagName.toLowerCase()}${ae.id ? "#" + ae.id : ""}${ae.getAttribute("name") ? `[name=${ae.getAttribute("name")}]` : ""}` : null };
    })
    .catch(() => ({ url: page.url(), dialogs: [] as string[], focus: null as string | null }));

  const t0 = Date.now();
  await action();
  await page.waitForTimeout(windowMs);
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  const after = await page
    .evaluate(() => {
      const w = window as unknown as { __forgeObs?: MutationObserver; __forgeCounts?: Record<string, number> };
      w.__forgeObs?.disconnect();
      const dialogs = Array.from(document.querySelectorAll("dialog[open],[role=dialog]")).map((d) => d.getAttribute("aria-label") ?? "");
      const ae = document.activeElement;
      return {
        counts: w.__forgeCounts ?? null,
        url: location.href,
        dialogs,
        focus: ae ? `${ae.tagName.toLowerCase()}${ae.id ? "#" + ae.id : ""}${ae.getAttribute("name") ? `[name=${ae.getAttribute("name")}]` : ""}` : null,
      };
    })
    .catch(() => ({ counts: null, url: page.url(), dialogs: [] as string[], focus: null as string | null }));

  page.off("request", onReq);
  page.off("requestfinished", onDone);
  page.off("requestfailed", onFail);

  // A full navigation replaces the document (and our observer); count it as DOM churn.
  const navigated = after.counts === null || after.url.split("#")[0] !== before.url.split("#")[0];
  const counts = after.counts ?? { added: navigated ? 1 : 0, removed: navigated ? 1 : 0, attr: 0, char: 0 };
  const newDialogs = after.dialogs.filter((d) => !before.dialogs.includes(d));
  const urlChanged = after.url !== before.url;
  const window_ms = Date.now() - t0;

  return {
    endpoints,
    page_effect: {
      dom: { added: counts.added, removed: counts.removed, attr_changes: counts.attr, text_changes: counts.char },
      url: { changed: urlChanged, before: before.url, after: after.url },
      focus: { changed: before.focus !== after.focus, before_selector: before.focus, after_selector: after.focus },
      network: { requests_started: started, requests_completed: completed, in_flight_at_end: Math.max(0, started - completed) },
      console_errors: 0,
      window_ms,
    },
    effect: {
      url_changed: urlChanged,
      mutations: { added: counts.added, removed: counts.removed, attr: counts.attr, char: counts.char },
      network: { requests: started, failed, endpoints: endpoints.map((e) => e.split(" ")[1]) },
      new_dialogs: newDialogs.map((name, i) => ({ role: "dialog", name, ref: String(i + 1) })),
      focus_moved_to: before.focus !== after.focus ? after.focus : null,
      console_errors: 0,
    },
  };
}

export function findNode(snapshot: SnapshotNode[], ref: number): SnapshotNode | undefined {
  return snapshot.find((n) => n.ref === ref);
}
