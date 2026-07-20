import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Test config is kept separate from vite.config.ts so the production build
// (and the Docker build) never depends on the test toolchain.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
