/**
 * Template paths that exist only when an optional capability is enabled, and
 * the manifest edits that enable it. create-trestlejs and `trestle upgrade`
 * share these rules, so an upgrade neither adds a disabled capability's files
 * nor mistakes an enabled capability's manifest for drift.
 */
/** admin: the platform admin; trigger: the trigger.dev job runtime (apps/jobs). */
export type OptionalTemplateCapability = "admin" | "trigger";

const optionalRoots: Readonly<Record<string, OptionalTemplateCapability>> = { "apps/admin": "admin", "apps/jobs": "trigger" };

export function templatePathCapability(relative: string): OptionalTemplateCapability | undefined {
  for (const [root, capability] of Object.entries(optionalRoots)) {
    if (relative === root || relative.startsWith(`${root}/`)) return capability;
  }
  return undefined;
}

/** Renders the project manifest for the enabled optional capabilities. */
export function applyManifestCapabilities(manifestText: string, enabled: ReadonlySet<OptionalTemplateCapability>): string {
  let rendered = manifestText;
  if (enabled.has("trigger") && !/^jobs:/mu.test(rendered)) {
    rendered = rendered.replace(/^(environments:\n)/mu, "jobs:\n  runtime: trigger\n  hosting: cloud\n$1");
    if (!/^jobs:\n  runtime: trigger/mu.test(rendered)) throw new Error("Unable to select the trigger.dev job runtime in the project manifest");
  }
  if (!enabled.has("admin")) return rendered;
  const updated = rendered
    .replace(/^(  worker: apps\/worker\n)/mu, "$1  admin: apps/admin\n")
    .replace(/^(capabilities:\n(?:  .*\n)*?  admin: )false$/mu, "$1true");
  if (!updated.includes("  admin: apps/admin\n") || !/^capabilities:\n(?:  .*\n)*?  admin: true$/mu.test(updated)) throw new Error("Unable to enable the admin capability in the project manifest");
  return updated;
}

/** Template files whose rendering depends on the enabled capabilities, besides the manifest. */
export const capabilityRenderedFiles = ["apps/worker/wrangler.jsonc"] as const;

/**
 * Renders a capability-dependent template file. With the trigger.dev runtime
 * the Worker selects it and knows its API; TRIGGER_SECRET_KEY stays a secret.
 */
export function applyFileCapabilities(relative: string, text: string, enabled: ReadonlySet<OptionalTemplateCapability>): string {
  if (relative !== "apps/worker/wrangler.jsonc" || !enabled.has("trigger")) return text;
  const updated = text.replace(/"APP_ENV": "(local|preview|staging|production)"/gu, '"APP_ENV": "$1", "TRESTLE_JOB_RUNTIME": "trigger", "TRIGGER_API_URL": "https://api.trigger.dev"');
  if ((updated.match(/"TRESTLE_JOB_RUNTIME": "trigger"/gu) ?? []).length !== 4) throw new Error("Unable to select the trigger.dev job runtime in apps/worker/wrangler.jsonc");
  return updated;
}
