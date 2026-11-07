import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: { "@forge/core": fileURLToPath(new URL("../../../packages/core/src/index.ts", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:4317", "/demo": "http://127.0.0.1:4317" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
