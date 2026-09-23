/**
 * Template paths that exist only when an optional capability is enabled, and
 * the manifest edits that enable it. create-trestlejs and `trestle upgrade`
 * share these rules, so an upgrade neither adds a disabled capability's files
 * nor mistakes an enabled capability's manifest for drift.
 */
export type OptionalTemplateCapability = "admin";

const optionalRoots: Readonly<Record<string, OptionalTemplateCapability>> = { "apps/admin": "admin" };

export function templatePathCapability(relative: string): OptionalTemplateCapability | undefined {
  for (const [root, capability] of Object.entries(optionalRoots)) {
    if (relative === root || relative.startsWith(`${root}/`)) return capability;
  }
  return undefined;
}

/** Renders the project manifest for the enabled optional capabilities. */
export function applyManifestCapabilities(manifestText: string, enabled: ReadonlySet<OptionalTemplateCapability>): string {
  if (!enabled.has("admin")) return manifestText;
  const updated = manifestText
    .replace(/^(  worker: apps\/worker\n)/mu, "$1  admin: apps/admin\n")
    .replace(/^(capabilities:\n(?:  .*\n)*?  admin: )false$/mu, "$1true");
  if (!updated.includes("  admin: apps/admin\n") || !/^capabilities:\n(?:  .*\n)*?  admin: true$/mu.test(updated)) throw new Error("Unable to enable the admin capability in the project manifest");
  return updated;
}
