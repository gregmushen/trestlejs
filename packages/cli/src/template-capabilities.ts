/**
 * Template paths that exist only when an optional capability is enabled, and
 * the manifest edits that enable it. create-trestlejs and `trestle upgrade`
 * share these rules, so an upgrade neither adds a disabled capability's files
 * nor mistakes an enabled capability's manifest for drift.
 */
/** admin: the platform admin; trigger / inngest: the trigger.dev (apps/jobs) or Inngest (apps/worker/src/inngest) job runtime. */
export type OptionalTemplateCapability = "admin" | "trigger" | "inngest";

const optionalRoots: Readonly<Record<string, OptionalTemplateCapability>> = { "apps/admin": "admin", "apps/jobs": "trigger", "apps/worker/src/inngest": "inngest" };

export function templatePathCapability(relative: string): OptionalTemplateCapability | undefined {
  for (const [root, capability] of Object.entries(optionalRoots)) {
    if (relative === root || relative.startsWith(`${root}/`)) return capability;
  }
  return undefined;
}

/** Renders the project manifest for the enabled optional capabilities. */
export function applyManifestCapabilities(manifestText: string, enabled: ReadonlySet<OptionalTemplateCapability>): string {
  let rendered = manifestText;
  for (const runtime of ["trigger", "inngest"] as const) {
    if (!enabled.has(runtime) || /^jobs:/mu.test(rendered)) continue;
    rendered = rendered.replace(/^(environments:\n)/mu, `jobs:\n  runtime: ${runtime}\n  hosting: cloud\n$1`);
    if (!new RegExp(`^jobs:\\n  runtime: ${runtime}`, "mu").test(rendered)) throw new Error(`Unable to select the ${runtime} job runtime in the project manifest`);
  }
  if (!enabled.has("admin")) return rendered;
  const updated = rendered
    .replace(/^(  worker: apps\/worker\n)/mu, "$1  admin: apps/admin\n")
    .replace(/^(capabilities:\n(?:  .*\n)*?  admin: )false$/mu, "$1true");
  if (!updated.includes("  admin: apps/admin\n") || !/^capabilities:\n(?:  .*\n)*?  admin: true$/mu.test(updated)) throw new Error("Unable to enable the admin capability in the project manifest");
  return updated;
}

/** Template files whose rendering depends on the enabled capabilities, besides the manifest. */
export const capabilityRenderedFiles = ["apps/worker/wrangler.jsonc", "apps/worker/package.json", "apps/worker/src/index.ts", "packages/authz/src/routes.ts"] as const;

/**
 * Renders a capability-dependent template file. With the trigger.dev runtime
 * the Worker selects it and knows its API; TRIGGER_SECRET_KEY stays a secret.
 */
export function applyFileCapabilities(relative: string, text: string, enabled: ReadonlySet<OptionalTemplateCapability>): string {
  const exactlyOnce = (source: string, anchor: string, replacement: string) => {
    if (source.split(anchor).length !== 2) throw new Error(`Unable to enable the job runtime in ${relative}`);
    return source.replace(anchor, replacement);
  };
  if (relative === "apps/worker/wrangler.jsonc" && (enabled.has("trigger") || enabled.has("inngest"))) {
    const variables = enabled.has("trigger") ? '"TRESTLE_JOB_RUNTIME": "trigger", "TRIGGER_API_URL": "https://api.trigger.dev"' : '"TRESTLE_JOB_RUNTIME": "inngest"';
    const updated = text.replace(/"APP_ENV": "(local|preview|staging|production)"/gu, `"APP_ENV": "$1", ${variables}`);
    if ((updated.match(/"TRESTLE_JOB_RUNTIME": /gu) ?? []).length !== 4) throw new Error("Unable to select the job runtime in apps/worker/wrangler.jsonc");
    return updated;
  }
  if (!enabled.has("inngest")) return text;
  if (relative === "apps/worker/package.json") return exactlyOnce(text, '  "dependencies": {\n', '  "dependencies": {\n    "inngest": "4.21.0",\n');
  if (relative === "apps/worker/src/index.ts") {
    const imported = exactlyOnce(text, 'import { inngestRuntime } from "./job-runtime-inngest.js";\n', 'import { inngestRuntime } from "./job-runtime-inngest.js";\nimport { inngestRoutes } from "./inngest/serve.js";\n');
    return exactlyOnce(imported, 'app.route("/", regionalRoutes);\n', 'app.route("/", regionalRoutes);\n// The signed endpoint Inngest calls (jobs.runtime: inngest).\napp.route("/", inngestRoutes);\n');
  }
  if (relative === "packages/authz/src/routes.ts") {
    const policies = ["GET", "POST", "PUT"].map((method) => `  { method: "${method}", path: "/api/jobs/inngest", public: true, audience: "public" },\n`).join("");
    return exactlyOnce(text, '  { method: "GET", path: "/api/health/operational", public: true, audience: "public" },\n', `  { method: "GET", path: "/api/health/operational", public: true, audience: "public" },\n  // Inngest's signed calls; the SDK verifies INNGEST_SIGNING_KEY.\n${policies}`);
  }
  return text;
}
