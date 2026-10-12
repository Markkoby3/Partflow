import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the dashboard proxies to the two services; in production nginx does the same.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api/inventory": { target: process.env.INVENTORY_API_URL ?? "http://localhost:8080", rewrite: (p) => p.replace(/^\/api\/inventory/, "") },
      "/api/reorder": { target: process.env.REORDER_API_URL ?? "http://localhost:8090", rewrite: (p) => p.replace(/^\/api\/reorder/, "") },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
