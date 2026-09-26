// Lets Node load the Worker's registrations (for `trestle jobs list`) by
// resolving Cloudflare's runtime modules to the test shim. Never used in Workers.
import { register } from "node:module";

register("data:text/javascript," + encodeURIComponent(`
  const shim = new URL("../apps/worker/src/cloudflare-workflow.test-shim.ts", ${JSON.stringify(import.meta.url)}).href;
  export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers" || specifier === "cloudflare:workflows") return { url: shim, shortCircuit: true };
    return next(specifier, context);
  }
`));
