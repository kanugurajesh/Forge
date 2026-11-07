import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { compileTrajectory, lintProcedure, parseTrajectory, parseYaml, validateProcedure, type Procedure } from "@forge/core";
import { Store, type RunReport } from "./store.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB_DIST = join(ROOT, "apps/hub/web/dist");
const DEMO_DIR = join(ROOT, "apps/demo");
const FIXTURES = join(ROOT, "fixtures");
const MAX_BODY = 2 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function json<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || "{}") as T;
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

async function serveFile(res: ServerResponse, base: string, rel: string, fallback?: string) {
  const safe = normalize(rel).replace(/^([/\\])+/, "").replace(/^(\.\.[/\\])+/, "");
  let file = join(base, safe);
  if (!file.startsWith(base)) return send(res, 403, { error: "forbidden" });
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, "index.html");
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    if (fallback) return serveFile(res, base, fallback);
    send(res, 404, { error: "not found" });
  }
}

// ---------------------------------------------------------------- demo target app ("Relay Mail")

interface Msg {
  id: number;
  from: string;
  to: string;
  subject: string;
  body: string;
  when: string;
}
const INBOX: Msg[] = [
  { id: 1, from: "Priya Raman", to: "me", subject: "Launch checklist for Friday", body: "", when: "9:41" },
  { id: 2, from: "Vercel", to: "me", subject: "Preview ready: feat/billing-upgrade", body: "", when: "9:12" },
  { id: 3, from: "Alex Chen", to: "me", subject: "Q3 numbers — need your sign-off", body: "", when: "Tue" },
  { id: 4, from: "Linear", to: "me", subject: "WEB-142 assigned to you", body: "", when: "Mon" },
  { id: 5, from: "Stripe", to: "me", subject: "Your invoice from Stripe", body: "", when: "Mon" },
];
let SENT: Msg[] = [];

async function demoApi(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
  if (path === "/demo/api/inbox") return send(res, 200, INBOX);
  if (path === "/demo/api/sent") return send(res, 200, SENT);
  if (path === "/demo/api/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    return send(res, 200, [...INBOX, ...SENT].filter((m) => `${m.from} ${m.to} ${m.subject}`.toLowerCase().includes(q)));
  }
  if (path === "/demo/api/send" && req.method === "POST") {
    const b = await json<Partial<Msg>>(req);
    const m: Msg = { id: Date.now(), from: "me", to: String(b.to ?? ""), subject: String(b.subject ?? ""), body: String(b.body ?? ""), when: "now" };
    SENT = [m, ...SENT].slice(0, 200);
    return send(res, 200, { ok: true, id: m.id });
  }
  if (path === "/demo/api/reset" && req.method === "POST") {
    SENT = [];
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: "not found" });
}

// ---------------------------------------------------------------- registry API

export function createApp(store: Store) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);
    try {
      if (path.startsWith("/demo/api/")) return await demoApi(req, res, path, url);
      if (path === "/demo" || path.startsWith("/demo/")) return await serveFile(res, DEMO_DIR, path.slice(5) || "index.html");

      if (path === "/api/health") return send(res, 200, { ok: true });
      if (path === "/api/stats") return send(res, 200, store.stats());

      if (path === "/api/procedures" && req.method === "GET") return send(res, 200, store.list(url.searchParams.get("q") ?? ""));
      if (path === "/api/procedures" && req.method === "POST") {
        const b = await json<{ yaml?: string; author?: string; compile?: unknown; changelog?: string }>(req);
        if (!b.yaml) return send(res, 400, { error: "yaml is required" });
        const r = store.publish(b.yaml, { author: b.author, compile: b.compile, changelog: b.changelog });
        return send(res, r.ok ? 201 : r.status, r);
      }

      const m = /^\/api\/procedures\/([a-z][a-z0-9_.-]{0,79})(\/runs|\/yaml)?$/.exec(path);
      if (m) {
        const [, name, sub] = m;
        if (!sub && req.method === "GET") {
          const d = store.get(name);
          return d ? send(res, 200, d) : send(res, 404, { error: "unknown procedure" });
        }
        if (sub === "/yaml" && req.method === "GET") {
          const y = store.exportYaml(name);
          return y ? send(res, 200, y, "text/yaml; charset=utf-8") : send(res, 404, { error: "unknown procedure" });
        }
        if (sub === "/runs" && req.method === "POST") {
          const r = store.reportRun(name, await json<RunReport>(req));
          return send(res, r.ok ? 201 : r.status, r);
        }
      }

      if (path === "/api/compile" && req.method === "POST") {
        const b = await json<{ trajectory?: string; name?: string; app?: string }>(req);
        if (!b.trajectory) return send(res, 400, { error: "trajectory (JSONL string) is required" });
        const traj = parseTrajectory(b.trajectory);
        if (traj.calls.length === 0) return send(res, 422, { error: "no tool calls found in trajectory" });
        return send(res, 200, compileTrajectory(traj, { name: b.name || undefined, app: b.app || undefined }));
      }
      if (path === "/api/lint" && req.method === "POST") {
        const b = await json<{ yaml?: string }>(req);
        let doc: Procedure;
        try {
          doc = parseYaml(b.yaml ?? "") as Procedure;
        } catch (e) {
          return send(res, 200, { schema: { valid: false, issues: [{ path: "/", message: (e as Error).message }] }, lint: [] });
        }
        return send(res, 200, { schema: validateProcedure(doc), lint: lintProcedure(doc) });
      }
      if (path.startsWith("/api/fixtures/")) return await serveFile(res, FIXTURES, path.slice("/api/fixtures/".length));
      if (path.startsWith("/api/")) return send(res, 404, { error: "not found" });

      return await serveFile(res, WEB_DIST, path === "/" ? "index.html" : path, "index.html");
    } catch (e) {
      const err = e as Error & { status?: number };
      send(res, err.status ?? 500, { error: err.message });
    }
  });
}
