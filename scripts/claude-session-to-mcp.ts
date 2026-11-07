/**
 * Export the BrowserOps tool calls from a Claude Code session transcript
 * (~/.claude/projects/<project>/<session>.jsonl) as raw MCP JSON-RPC:
 * one `tools/call` request and one response per call, which is the format
 * `forge compile` already accepts.
 *
 *   npx tsx scripts/claude-session-to-mcp.ts <session.jsonl> [--server browserops] [--after <tool_use_id>] > run.mcp.jsonl
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!file) {
  console.error("usage: claude-session-to-mcp <session.jsonl> [--server browserops] [--after <tool_use_id>]");
  process.exit(2);
}
const prefix = `mcp__${opt("server") ?? "browserops"}__`;
const after = opt("after");

type Block = { type: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

const out: string[] = [];
const ids = new Map<string, number>();
let started = !after;
let next = 1;

for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  let rec: { message?: { content?: unknown } };
  try {
    rec = JSON.parse(line);
  } catch {
    continue;
  }
  const content = rec.message?.content;
  if (!Array.isArray(content)) continue;
  for (const b of content as Block[]) {
    if (b.type === "tool_use" && b.name?.startsWith(prefix) && b.id) {
      if (!started) {
        if (b.id === after) started = true;
        continue;
      }
      const id = next++;
      ids.set(b.id, id);
      out.push(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: b.name.slice(prefix.length), arguments: b.input ?? {} } }));
    } else if (b.type === "tool_result" && b.tool_use_id && ids.has(b.tool_use_id)) {
      const text = typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content)
          ? (b.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n")
          : "";
      out.push(JSON.stringify({ jsonrpc: "2.0", id: ids.get(b.tool_use_id), result: { content: [{ type: "text", text }], isError: !!b.is_error } }));
    }
  }
}

process.stdout.write(out.join("\n") + "\n");
console.error(`exported ${ids.size} ${prefix}* calls`);
