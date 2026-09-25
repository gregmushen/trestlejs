import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: {
    "cloudflare:workers": fileURLToPath(new URL("./src/cloudflare-workflow.test-shim.ts", import.meta.url)),
    "cloudflare:workflows": fileURLToPath(new URL("./src/cloudflare-workflow.test-shim.ts", import.meta.url)),
  } },
});
