import type { SnapshotNode, ToolCall, Trajectory } from "../src/trajectory.ts";

const effect = (o: { added?: number; removed?: number; endpoints?: string[]; dialog?: string; url?: [string, string] } = {}) => ({
  page_effect: {
    dom: { added: o.added ?? 0, removed: o.removed ?? 0, attr_changes: 0, text_changes: 0 },
    url: o.url ? { changed: true, before: o.url[0], after: o.url[1] } : { changed: false },
    focus: { changed: false },
    network: { requests_started: o.endpoints?.length ?? 0, requests_completed: o.endpoints?.length ?? 0, in_flight_at_end: 0 },
    console_errors: 0,
    window_ms: 300,
  },
  effect: {
    url_changed: !!o.url,
    mutations: { added: o.added ?? 0, removed: o.removed ?? 0, attr: 0, char: 0 },
    network: { requests: o.endpoints?.length ?? 0, failed: 0, endpoints: o.endpoints ?? [] },
    new_dialogs: o.dialog ? [{ role: "dialog", name: o.dialog, ref: "40" }] : [],
    console_errors: 0,
  },
});
const ZERO = effect();

export const inboxSnapshot: SnapshotNode[] = [
  { ref: 1, role: "button", name: "Compose", attrs: { "data-testid": "compose" } },
  { ref: 2, role: "link", name: "Inbox", attrs: { href: "/inbox" } },
  { ref: 3, role: "button", name: "Delete" },
  { ref: 4, role: "button", name: "Archive" },
  { ref: 5, role: "textbox", name: "Search mail", attrs: { "aria-label": "Search mail" } },
];

export const composeSnapshot: SnapshotNode[] = [
  ...inboxSnapshot,
  { ref: 10, role: "textbox", name: "To", attrs: { name: "to" }, dialog: "New message" },
  { ref: 11, role: "textbox", name: "Subject", attrs: { name: "subject" }, dialog: "New message" },
  { ref: 12, role: "textbox", name: "Message body", attrs: { "aria-label": "Message body" }, dialog: "New message" },
  { ref: 13, role: "button", name: "Send", dialog: "New message" },
  { ref: 14, role: "button", name: "Schedule send", dialog: "New message" },
  { ref: 15, role: "button", name: "Discard draft", dialog: "New message" },
];

const afterSend: SnapshotNode[] = [...inboxSnapshot, { ref: 30, role: "status", name: "Message sent: Q3 numbers" }];

let seq = 0;
const call = (tool: string, args: Record<string, unknown>, result: Record<string, unknown> = {}): ToolCall => ({
  seq: seq++,
  tool,
  args,
  result: { ok: true, ...result },
  usage: { input_tokens: 1200, output_tokens: 80 },
});

export function gmailTrajectory(): Trajectory {
  seq = 0;
  return {
    task: "send an email in Acme Mail",
    app: "acmemail",
    calls: [
      call("browser_list_tabs", {}),
      call("browser_navigate", { url: "https://mail.acme.test/" }, { ...effect({ url: ["about:blank", "https://mail.acme.test/inbox"] }) }),
      call("browser_navigate", { url: "https://mail.acme.test/inbox" }, { ...effect({ url: ["https://mail.acme.test/", "https://mail.acme.test/inbox"] }) }),
      call("browser_read", { mode: "a11y_tree" }, { snapshot: inboxSnapshot }),
      call("browser_screenshot", {}),
      call("browser_click", { ref: 2 }, { clicked: true, ...ZERO }),
      call("browser_click", { ref: 1 }, { clicked: true, ...effect({ added: 14, dialog: "New message" }) }),
      call("browser_read", { mode: "a11y_tree" }, { snapshot: composeSnapshot }),
      call("browser_type", { ref: 10, text: "dana@acme.test" }, effect({ added: 1 })),
      call("browser_type", { ref: 11, text: "Q3 numbrs" }, effect({ added: 1 })),
      call("browser_type", { ref: 11, text: "Q3 numbers" }, effect({ added: 1 })),
      call("browser_type", { ref: 12, text: "Numbers attached." }, effect({ added: 1 })),
      call("browser_click", { ref: 99 }, { ok: false, error: "ref 99 not found" }),
      call("browser_click", { ref: 13 }, { clicked: true, ...effect({ removed: 14, endpoints: ["https://mail.acme.test/api/send"] }) }),
      call("browser_read", { mode: "a11y_tree" }, { snapshot: afterSend }),
    ],
  };
}
