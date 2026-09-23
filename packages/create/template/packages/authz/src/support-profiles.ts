import { permissions } from "./permissions.js";
import type { PermissionRegistry } from "./registry.js";

/**
 * A support access profile is the exact tenant authority an operator holds
 * during a support session. Profiles are application-owned source, reviewed
 * like permissions: runtime administration selects one but cannot edit it.
 * The platform permission that starts a session grants no tenant authority by
 * itself; this profile does, and only while the session is active.
 */
export type SupportProfileDefinition = Readonly<{
  name: string;
  description: string;
  organization: readonly string[];
  application: readonly string[];
}>;

export type SupportProfile = SupportProfileDefinition & Readonly<{ key: string }>;

export class SupportProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportProfileError";
  }
}

export type SupportProfileCatalog = Readonly<{
  get(key: string): SupportProfile | undefined;
  list(): SupportProfile[];
}>;

export function defineSupportProfiles(registry: PermissionRegistry, definitions: Readonly<Record<string, SupportProfileDefinition>>): SupportProfileCatalog {
  const profiles = new Map<string, SupportProfile>();
  for (const [key, definition] of Object.entries(definitions)) {
    if (!/^[a-z][a-z0-9_]{1,39}$/u.test(key)) throw new SupportProfileError(`Support profile ${key} must be a lowercase key`);
    for (const plane of ["organization", "application"] as const) {
      for (const code of definition[plane]) {
        const permission = registry.get(code);
        if (!permission) throw new SupportProfileError(`Support profile ${key} grants unregistered permission ${code}`);
        if (permission.plane !== plane) throw new SupportProfileError(`Support profile ${key} lists ${code} under ${plane}, but it is a ${permission.plane}-plane permission`);
        if (permission.secret) throw new SupportProfileError(`Support profile ${key} cannot grant ${code}: secret access is never grantable through support`);
      }
    }
    profiles.set(key, { key, ...definition, organization: [...definition.organization].sort(), application: [...definition.application].sort() });
  }
  return { get: (key) => profiles.get(key), list: () => [...profiles.values()] };
}

export const supportProfiles = defineSupportProfiles(permissions, {
  read_only: {
    name: "Read-only support",
    description: "Inspect the tenant's configuration and product data without changing anything",
    organization: ["organization.read", "organization.members.read", "organization.entitlements.read", "organization.service_accounts.read", "organization.webhooks.read", "organization.notifications.read", "organization.settings.regional.read", "organization.audit.read"],
    application: ["application.roles.read", "resource.read", "workflows.read"],
  },
  integration_support: {
    name: "Integration support",
    description: "Diagnose and repair webhook delivery: pause, resume, test, and replay endpoints",
    organization: ["organization.read", "organization.members.read", "organization.webhooks.read", "organization.webhooks.manage", "organization.webhooks.replay", "organization.audit.read"],
    application: ["resource.read"],
  },
  regional_support: {
    name: "Regional settings support",
    description: "Inspect and correct the organization's language, locale, time zone, and currency defaults with tenant authority",
    organization: ["organization.read", "organization.members.read", "organization.settings.regional.read", "organization.settings.regional.manage", "organization.audit.read"],
    application: [],
  },
});

/** The effective organization and application authority a profile grants. */
export function supportAuthority(profile: SupportProfile) {
  const grant = (codes: readonly string[]) => new Map(codes.map((code) => [code, [`support:${profile.key}`]] as const));
  return { organization: grant(profile.organization), application: grant(profile.application) };
}

export type SupportPermissionPreview = Readonly<{ code: string; plane: "organization" | "application"; description: string; allowed: boolean; reason: string }>;

/**
 * Previews exactly what a profile allows in one tenant: every organization and
 * application permission, granted or denied, and why. Entitlement-gated
 * permissions the tenant's plan does not include are denied even if listed.
 */
export function previewSupportProfile(registry: PermissionRegistry, profile: SupportProfile, entitlements: { has(code: string): boolean }): SupportPermissionPreview[] {
  return (["organization", "application"] as const).flatMap((plane) => registry.list(plane).map((permission) => {
    const listed = profile[plane].includes(permission.code);
    const reason = permission.secret ? "secret access is never grantable through support"
      : !listed ? `not in the ${profile.name} profile`
        : permission.entitlement && !entitlements.has(permission.entitlement) ? `the tenant's plan does not include ${permission.entitlement}`
          : `granted by the ${profile.name} profile`;
    return { code: permission.code, plane, description: permission.description, allowed: listed && !permission.secret && (!permission.entitlement || entitlements.has(permission.entitlement)), reason };
  }));
}
