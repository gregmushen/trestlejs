import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./src/cloudflare-workflow.test-shim.ts", import.meta.url)) } },
  // Wrangler bundles the project manifest as text; mirror that for tests.
  // Integration suites run against real PostgreSQL alongside other packages' suites.
  test: { testTimeout: 15_000 },
  plugins: [{ name: "trestle-yaml-text", transform: (code, id) => id.endsWith(".yaml") ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined }],
});
