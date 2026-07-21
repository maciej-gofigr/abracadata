import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: {
    format: "es",
  },
  // Dev: proxy /api to the FastAPI backend (prod uses the same /api path via nginx).
  server: {
    // Bind all interfaces so the dev server is reachable from other devices on
    // the LAN (http://<your-lan-ip>:5173). /api is still proxied to the backend
    // on this machine, so the backend need not be exposed separately.
    host: true,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
