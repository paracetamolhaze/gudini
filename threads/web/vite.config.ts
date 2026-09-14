import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const prefix = (process.env.THREADS_URL_PREFIX ?? "/threads").replace(/\/+$/, "");

// The dashboard is served by Fastify under the same prefix as the API, so assets use relative paths.
export default defineConfig({
  root: here,
  base: `${prefix}/`,
  plugins: [react()],
  build: { outDir: path.join(here, "dist"), emptyOutDir: true, sourcemap: false },
  server: {
    port: 8601,
    proxy: { [`${prefix}/api`]: "http://127.0.0.1:8600", [`${prefix}/health`]: "http://127.0.0.1:8600", [`${prefix}/media`]: "http://127.0.0.1:8600" },
  },
});
