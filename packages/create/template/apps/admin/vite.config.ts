/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const adminApiOrigin = process.env.TRESTLE_ADMIN_API_ORIGIN ?? "http://127.0.0.1:8788";

export default defineConfig({
  plugins: [react(), tailwindcss(),
    // Wrangler bundles the project manifest as text; mirror that for Worker tests.
    { name: "trestle-yaml-text", transform: (code, id) => id.endsWith(".yaml") ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined }],
  server: {
    proxy: {
      "/api/admin": adminApiOrigin,
      "/api/auth": adminApiOrigin,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "worker/**/*.test.ts"],
    // Worker integration tests run against real PostgreSQL alongside other suites.
    testTimeout: 15_000,
  },
});
