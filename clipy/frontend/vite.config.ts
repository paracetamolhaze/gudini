import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// served by the FastAPI backend under /clipy; in dev the API is proxied to the backend on 8500
export default defineConfig({
  base: "/clipy/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/clipy/api": { target: "http://127.0.0.1:8500", changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
