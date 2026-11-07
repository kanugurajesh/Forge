import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { Store } from "./store.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const port = Number(process.env.PORT ?? 4317);
const dbFile = process.env.FORGE_DB ?? join(ROOT, ".forge-data", "hub.db");

const store = new Store(dbFile);
createApp(store).listen(port, "127.0.0.1", () => {
  console.log(`Forge Hub   http://127.0.0.1:${port}`);
  console.log(`Demo app    http://127.0.0.1:${port}/demo/`);
  console.log(`Database    ${dbFile}`);
});
