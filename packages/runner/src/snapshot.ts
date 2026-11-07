import type { Page } from "playwright";
import type { SnapshotNode } from "@forge/core";

/**
 * In-page a11y-ish snapshot. Produces the same node shape browser_read gives
 * the compiler: role, accessible name, tier-1 attributes, text, enclosing dialog.
 *
 * Refs are content-stable: a hash of the element's DOM path, written to
 * `data-forge-ref`. The same control keeps its ref across reads and reloads,
 * and a ref change means the target genuinely moved, which is what the
 * `target_changed` drift signal measures.
 */
export async function snapshotPage(page: Page): Promise<SnapshotNode[]> {
  return page.evaluate(() => {
    const INTERACTIVE = "a[href],button,input:not([type=hidden]),textarea,select,[role],dialog,[contenteditable=true]";
    const implicitRole = (el: Element): string => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "combobox";
      if (tag === "dialog") return "dialog";
      if (tag === "input") {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "search") return "searchbox";
        if (t === "submit" || t === "button") return "button";
        return "textbox";
      }
      return "generic";
    };
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const accName = (el: Element): string => {
      const aria = el.getAttribute("aria-label");
      if (aria) return clean(aria);
      const by = el.getAttribute("aria-labelledby");
      if (by) return clean(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(" "));
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) return clean(lab.textContent);
      }
      const wrap = el.closest("label");
      if (wrap && wrap !== el) {
        const copy = wrap.cloneNode(true) as Element;
        copy.querySelectorAll("input,textarea,select").forEach((n) => n.remove());
        const t = clean(copy.textContent);
        if (t) return t;
      }
      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea") return clean(el.getAttribute("placeholder") || el.getAttribute("title"));
      if (tag === "dialog") return clean(el.querySelector("h1,h2,h3")?.textContent);
      return clean((el as HTMLElement).innerText || el.textContent || el.getAttribute("title")).slice(0, 120);
    };
    const pathOf = (el: Element): string => {
      const parts: string[] = [];
      for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
        const p: Element | null = n.parentElement;
        const idx = p ? Array.from(p.children).filter((c) => c.tagName === n!.tagName).indexOf(n) : 0;
        parts.push(`${n.tagName}${idx}`);
      }
      return parts.reverse().join("/");
    };
    const fnv = (s: string) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
      return (h % 999983) + 1;
    };
    const visible = (el: Element) => {
      if (el.tagName === "DIALOG") return (el as HTMLDialogElement).open;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const out: SnapshotNode[] = [];
    for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) {
      if (!visible(el)) continue;
      const role = implicitRole(el);
      if (role === "generic" || role === "presentation" || role === "none") continue;
      const ref = fnv(pathOf(el));
      if (el.getAttribute("data-forge-ref") !== String(ref)) el.setAttribute("data-forge-ref", String(ref));
      const attrs: Record<string, string> = {};
      for (const a of ["aria-label", "data-testid", "href", "name", "id", "type", "placeholder"]) {
        const v = el.getAttribute(a);
        if (v) attrs[a] = v;
      }
      const dlg = el.closest("dialog,[role=dialog]");
      const node: SnapshotNode = { ref, role, name: accName(el), attrs };
      const text = clean((el as HTMLElement).innerText).slice(0, 200);
      if (text && text !== node.name) node.text = text;
      if (dlg && dlg !== el) node.dialog = accName(dlg);
      out.push(node);
    }
    return out;
  });
}

export function refSelector(ref: number): string {
  return `[data-forge-ref="${ref}"]`;
}
