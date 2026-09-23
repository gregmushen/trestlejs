import { describe, expect, it } from "vitest";

import { permissions as registry } from "./permissions.js";
import { defineSupportProfiles, previewSupportProfile, supportProfiles } from "./support-profiles.js";
import { assuranceForEndpoint, meetsRequirement, platformAssuranceRequirement, securityEventForEndpoint } from "./assurance.js";
import { credentialAccess } from "./credential-verifier.js";
import { buildAccessCatalog, catalogRoleProblems, runtimePermissionProblems } from "./access-catalog.js";

import {
  AccessDeniedError,
  AccessEvaluator,
  apiKeyStatus,
  applicationRoles,
  bearerApiKey,
  defineRoles,
  defineRoutePolicies,
  definePermissions,
  evaluateAccess,
  formatAccessExplanation,
  ipAllowed,
  mintApiKey,
  organizationCreatorAssignments,
  organizationRoles,
  parseApiKey,
  parseMembershipRoles,
  permissions,
  platformRoles,
  publicDenial,
  rotationExpiry,
  validateApiKeyScopes,
  verifyApiKey,
  type AccessSubject,
  type EntitlementSource,
} from "./index.js";

const entitled = (...codes: string[]): EntitlementSource => ({
  get: (code) => codes.includes(code) ? { code, enabled: true, source: "plan", inheritedFrom: "pro@3" } : undefined,
});

const human = (roles: { organization?: string[]; application?: string[]; platform?: string[] } = {}, entitlements = entitled()): AccessSubject => ({
  principal: { type: "user", id: "user-1", label: "Jane Smith" },
  tenant: { organizationId: "org-a", label: "Acme" },
  authority: {
    organization: organizationRoles.resolve(roles.organization ?? []).permissions,
    application: applicationRoles.resolve(roles.application ?? []).permissions,
    platform: platformRoles.resolve(roles.platform ?? []).permissions,
  },
  assignments: { organization: roles.organization ?? [], application: roles.application ?? [], platform: roles.platform ?? [] },
  entitlements,
});

const allCodes = permissions.list().map(({ code }) => code);

describe("permission registry", () => {
  it("requires exactly one validated authority plane per permission", () => {
    expect(() => definePermissions({ Bad: { plane: "application", description: "x" } })).toThrow("lowercase dotted");
    expect(() => definePermissions({ "a.b": { plane: "tenant" as never, description: "x" } })).toThrow("must declare an organization, application, or platform plane");
    expect(() => definePermissions({ "organization.x": { plane: "application", description: "x" } })).toThrow("declares the application plane");
    expect(() => definePermissions({ "billing.x": { plane: "organization", description: "x" } })).toThrow("must use the organization. prefix");
    expect(() => definePermissions({ "platform.x": { plane: "platform", description: "x", principals: ["api_key"] } })).toThrow("only grantable to human users");
    expect(() => definePermissions({ "a.b": { plane: "application", description: "x", principals: ["user", "user"] } })).toThrow("repeats");
  });

  it("assigns every registered permission to one plane", () => {
    for (const plane of ["organization", "application", "platform"] as const) expect(permissions.list(plane).length).toBeGreaterThan(0);
    expect(permissions.list("organization").length + permissions.list("application").length + permissions.list("platform").length).toBe(allCodes.length);
  });

  it("enables machine access only for explicitly machine-capable application permissions", () => {
    expect(permissions.list("organization").some(({ principals }) => principals.includes("api_key"))).toBe(false);
    expect(permissions.list("platform").some(({ principals }) => principals.includes("api_key"))).toBe(false);
  });
});

describe("roles", () => {
  it("cannot contain a permission from another authority plane", () => {
    expect(() => defineRoles(permissions, "organization", { bad: { name: "Bad", description: "", permissions: ["resource.read"] as never } })).toThrow("organization role bad cannot grant application permission resource.read");
    expect(() => defineRoles(permissions, "application", { bad: { name: "Bad", description: "", permissions: ["platform.audit.read"] as never } })).toThrow("cannot grant platform permission");
    for (const catalog of [organizationRoles, applicationRoles, platformRoles]) {
      for (const role of catalog.list()) expect(role.permissions.every((code) => permissions.get(code)?.plane === catalog.plane)).toBe(true);
    }
  });

  it("resolve deterministic effective permissions with role provenance in each plane", () => {
    const { permissions: effective, unknownRoles } = applicationRoles.resolve(parseMembershipRoles("reader, editor,ghost"));
    expect(unknownRoles).toEqual(["ghost"]);
    expect(effective.get("resource.read")).toEqual(["editor", "reader"]);
    expect([...applicationRoles.resolve(["editor", "reader"]).permissions]).toEqual([...effective]);
    expect(organizationRoles.resolve(["member", "billing_admin"]).permissions.get("organization.entitlements.read")).toEqual(["billing_admin", "member"]);
  });

  it("supports validated custom application roles only", () => {
    const catalog = applicationRoles.withCustomRoles([{ key: "auditor", name: "Auditor", permissions: ["resource.read"] }]);
    expect(catalog.resolve(["auditor"]).permissions.get("resource.read")).toEqual(["auditor"]);
    expect(() => applicationRoles.withCustomRoles([{ key: "x", name: "X", permissions: ["organization.read"] }])).toThrow("must be a lowercase key");
    expect(() => applicationRoles.withCustomRoles([{ key: "sneaky", name: "Sneaky", permissions: ["organization.members.invite"] }])).toThrow("cannot grant organization permission");
    expect(() => applicationRoles.withCustomRoles([{ key: "editor", name: "Editor", permissions: [] }])).toThrow("collides");
    expect(() => organizationRoles.withCustomRoles([])).toThrow("application roles");
    expect(() => platformRoles.withCustomRoles([])).toThrow("application roles");
  });
});

describe("independent authority planes", () => {
  it("gives a user with no assignments no authority in any plane", () => {
    expect(new AccessEvaluator(permissions, human({}, entitled("api.access", "roles.custom", "workflows.advanced"))).permitted()).toEqual([]);
  });

  it("does not let organization Owner authority grant application or platform permissions", () => {
    const owner = new AccessEvaluator(permissions, human({ organization: ["owner"] }, entitled("api.access", "roles.custom", "workflows.advanced")));
    expect(owner.check({ permission: "organization.members.invite" })).toBe(true);
    expect(owner.permitted().every((code) => permissions.get(code)?.plane === "organization")).toBe(true);
    expect(owner.explain({ permission: "resource.write" }).reason).toBe("permission_missing");
    expect(owner.explain({ permission: "application.roles.assign" }).reason).toBe("permission_missing");
    expect(owner.explain({ permission: "platform.organizations.read" }).reason).toBe("permission_missing");
  });

  it("does not let application Administrator authority grant organization or platform permissions", () => {
    const appAdmin = new AccessEvaluator(permissions, human({ application: ["app_admin"] }, entitled("roles.custom", "workflows.advanced")));
    expect(appAdmin.check({ permission: "workflows.publish" })).toBe(true);
    expect(appAdmin.permitted().every((code) => permissions.get(code)?.plane === "application")).toBe(true);
    expect(appAdmin.check({ permission: "organization.members.invite" })).toBe(false);
    expect(appAdmin.check({ permission: "platform.jobs.redrive" })).toBe(false);
  });

  it("does not let platform roles imply tenant membership or application authority", () => {
    const operator = new AccessEvaluator(permissions, human({ platform: ["platform_operator", "support", "security_admin", "billing_operations"] }));
    expect(operator.check({ permission: "platform.jobs.redrive" })).toBe(true);
    expect(operator.permitted().every((code) => permissions.get(code)?.plane === "platform")).toBe(true);
    expect(operator.check({ permission: "organization.read" })).toBe(false);
    expect(operator.check({ permission: "resource.read" })).toBe(false);
  });

  it("evaluates commercial and actor authority separately with distinct reasons", () => {
    expect(evaluateAccess(permissions, human({ application: ["publisher"] }), { permission: "workflows.publish" })).toMatchObject({ allowed: false, reason: "entitlement_missing", permission: { plane: "application", granted: true, grantedBy: ["publisher"] } });
    expect(evaluateAccess(permissions, human({ application: ["reader"] }, entitled("workflows.advanced")), { permission: "workflows.publish" })).toMatchObject({ reason: "permission_missing", entitlement: { enabled: true, inheritedFrom: "pro@3" } });
    expect(evaluateAccess(permissions, human({ application: ["publisher"] }, entitled("workflows.advanced")), { permission: "workflows.publish" }).allowed).toBe(true);
  });

  it("never lets entitlements grant permissions", () => {
    expect(new AccessEvaluator(permissions, human({}, entitled("workflows.advanced", "roles.custom", "api.access"))).check({ permission: "workflows.publish" })).toBe(false);
  });

  it("fails closed for unknown permissions and missing tenant context", () => {
    expect(evaluateAccess(permissions, human({ organization: ["owner"] }), { permission: "made.up" }).reason).toBe("unknown_permission");
    const { tenant: _tenant, ...withoutTenant } = human({ organization: ["owner"] });
    expect(evaluateAccess(permissions, withoutTenant, { permission: "organization.read" }).reason).toBe("tenant_required");
  });

  it("explains the plane, assignments considered, and provenance", () => {
    const explanation = formatAccessExplanation(evaluateAccess(permissions, human({ organization: ["owner"], application: ["publisher"] }, entitled("workflows.advanced")), { permission: "workflows.publish" }));
    expect(explanation).toMatch(/Identity\s+Jane Smith/u);
    expect(explanation).toMatch(/Organization role\s+owner\s+organization authority only/u);
    expect(explanation).toMatch(/Application permission\s+workflows\.publish\s+granted by publisher/u);
    expect(explanation).toMatch(/Platform role\s+none\s+no platform authority/u);
    expect(explanation).toMatch(/Decision\s+ALLOWED/u);
  });

  it("declares the organization-creator bootstrap as an explicit cross-plane policy", () => {
    expect(organizationCreatorAssignments).toEqual([{ plane: "organization", role: "owner" }, { plane: "application", role: "app_admin" }]);
  });

  it("throws a typed denial with a caller-safe body", () => {
    try {
      new AccessEvaluator(permissions, human({ application: ["publisher"] })).require({ permission: "workflows.publish" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AccessDeniedError);
      expect((error as AccessDeniedError).status).toBe(403);
      expect(publicDenial((error as AccessDeniedError).decision)).toEqual({ error: "entitlement_required", reason: "entitlement_missing", entitlement: "workflows.advanced" });
    }
  });
});

describe("service accounts and API keys", () => {
  const serviceAccount = applicationRoles.resolve(["editor"]).permissions;
  const machine = (scopes: string[], status: "active" | "revoked" = "active"): AccessSubject => ({
    principal: { type: "service_account", id: "sa-1", label: "deploy-bot" },
    tenant: { organizationId: "org-a" },
    authority: { application: serviceAccount },
    assignments: { application: ["editor"] },
    scopes: new Set(scopes),
    credential: { id: "key-1", status },
    entitlements: entitled("api.access"),
    constraints: [{ name: "Environment", expected: "production", actual: "production", satisfied: true }],
  });

  it("only lets scopes reduce service-account application authority", () => {
    expect(evaluateAccess(permissions, machine(["resource.write"]), { permission: "resource.write" }).allowed).toBe(true);
    expect(evaluateAccess(permissions, machine(["resource.read"]), { permission: "resource.write" }).reason).toBe("scope_missing");
    expect(evaluateAccess(permissions, machine(["workflows.publish"]), { permission: "workflows.publish" }).reason).toBe("entitlement_missing");
    expect(evaluateAccess(permissions, machine(["organization.members.invite"]), { permission: "organization.members.invite" }).reason).toBe("principal_type_rejected");
    expect(evaluateAccess(permissions, machine(["resource.read"]), { permission: "resource.read", rejectApiKeys: true }).reason).toBe("principal_type_rejected");
    expect(evaluateAccess(permissions, machine(["resource.read"], "revoked"), { permission: "resource.read" }).reason).toBe("credential_inactive");
    expect(validateApiKeyScopes(permissions, ["resource.read", "resource.write"], serviceAccount)).toEqual([]);
    expect(validateApiKeyScopes(permissions, ["organization.api_keys.manage", "made.up", "platform.jobs.read", "workflows.publish"], serviceAccount)).toEqual([
      "organization.api_keys.manage cannot be granted to API keys",
      "made.up is not a registered permission",
      "platform.jobs.read cannot be granted to API keys",
      "workflows.publish exceeds the service account's permissions",
    ]);
    expect(formatAccessExplanation(evaluateAccess(permissions, machine(["resource.write"]), { permission: "resource.write" }))).toMatch(/API-key scope\s+resource\.write\s+present/u);
  });

  it("mints a one-time secret with a stored verifier only", async () => {
    const key = await mintApiKey("production");
    expect(key.token).toMatch(/^tr_live_[A-Za-z0-9]{16}_[A-Za-z0-9_-]{43}$/u);
    expect(key.displayPrefix).toBe(`tr_live_${key.publicId}`);
    expect(parseApiKey(key.token)).toEqual({ environmentPrefix: "live", publicId: key.publicId });
    expect(await verifyApiKey(key.token, key.verifier)).toBe(true);
    expect(await verifyApiKey(`${key.token.slice(0, -1)}x`, key.verifier)).toBe(false);
    expect(parseApiKey("tr_live_short_secret")).toBeNull();
    expect(bearerApiKey(`Bearer ${key.token}`)).toBe(key.token);
    expect(bearerApiKey("Basic abc")).toBeNull();
    expect((await mintApiKey("staging")).token.startsWith("tr_test_")).toBe(true);
  });

  it("fails closed for revoked, expired, rotated, wrong-environment, suspended, and off-network keys", () => {
    const now = new Date("2026-09-22T12:00:00Z");
    const base = { id: "k", organizationId: "org-a", serviceAccountId: "sa", environment: "production" as const, scopes: ["resource.read"] };
    const context = { now, environment: "production" as const, clientIp: "203.0.113.9", serviceAccountStatus: "active" as const };
    expect(apiKeyStatus(base, context)).toBe("active");
    expect(apiKeyStatus({ ...base, revokedAt: now }, context)).toBe("revoked");
    expect(apiKeyStatus({ ...base, expiresAt: rotationExpiry(new Date("2026-09-21T11:00:00Z"), 24) }, context)).toBe("expired");
    expect(apiKeyStatus(base, { ...context, environment: "staging" })).toBe("wrong_environment");
    expect(apiKeyStatus(base, { ...context, serviceAccountStatus: "suspended" })).toBe("service_account_suspended");
    expect(apiKeyStatus({ ...base, allowedCidrs: ["198.51.100.0/24"] }, context)).toBe("network_denied");
    expect(apiKeyStatus({ ...base, allowedCidrs: ["203.0.113.0/24"] }, context)).toBe("active");
    expect(() => rotationExpiry(now, 169)).toThrow(RangeError);
    expect(rotationExpiry(now, 48, new Date("2026-09-23T00:00:00Z")).toISOString()).toBe("2026-09-23T00:00:00.000Z");
  });

  it("matches IPv4 and IPv6 network restrictions", () => {
    expect(ipAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed("2001:db9::1", ["2001:db8::/32"])).toBe(false);
    expect(ipAllowed("10.1.2.3", ["2001:db8::/32", "10.0.0.0/8"])).toBe(true);
    expect(ipAllowed(undefined, ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("10.1.2.3", ["not-a-cidr"])).toBe(false);
  });
});

describe("route policies", () => {
  it("rejects policies that drift from the registry or mix planes", () => {
    expect(() => defineRoutePolicies(permissions, [{ method: "GET", path: "/x", audience: "tenant" }])).toThrow("must declare a permission");
    expect(() => defineRoutePolicies(permissions, [{ method: "GET", path: "/x", audience: "tenant", permission: "platform.audit.read" }])).toThrow("mixes");
    expect(() => defineRoutePolicies(permissions, [{ method: "GET", path: "/x", audience: "platform", permission: "organization.read" }])).toThrow("mixes");
    expect(() => defineRoutePolicies(permissions, [{ method: "GET", path: "/x", audience: "tenant", permission: "organization.members.read", principals: ["api_key"] }])).toThrow("does not allow");
    expect(() => defineRoutePolicies(permissions, [{ method: "GET", path: "/x", public: true, audience: "public" }, { method: "GET", path: "/x", public: true, audience: "public" }])).toThrow("more than one");
  });
});

describe("support profiles", () => {



  it("never grants secret, platform, or misplaced permissions", () => {
    expect(() => defineSupportProfiles(registry, { bad: { name: "x", description: "x", organization: ["organization.webhooks.rotate_secret"], application: [] } })).toThrow(/secret access/u);
    expect(() => defineSupportProfiles(registry, { bad: { name: "x", description: "x", organization: ["organization.api_keys.manage"], application: [] } })).toThrow(/secret access/u);
    expect(() => defineSupportProfiles(registry, { bad: { name: "x", description: "x", organization: ["platform.users.read"], application: [] } })).toThrow(/platform-plane/u);
    expect(() => defineSupportProfiles(registry, { bad: { name: "x", description: "x", organization: [], application: ["organization.read"] } })).toThrow(/organization-plane/u);
  });

  it("previews exactly what a profile grants in a tenant, including plan limits", () => {
    const preview = previewSupportProfile(registry, supportProfiles.get("read_only")!, { has: () => false });
    expect(preview.find((entry) => entry.code === "organization.members.read")).toMatchObject({ allowed: true });
    expect(preview.find((entry) => entry.code === "organization.service_accounts.read")).toMatchObject({ allowed: false, reason: expect.stringMatching(/plan does not include api.access/u) });
    expect(preview.find((entry) => entry.code === "organization.api_keys.manage")).toMatchObject({ allowed: false, reason: expect.stringMatching(/secret/u) });
    expect(preview.every((entry) => entry.plane !== ("platform" as never))).toBe(true);
  });
});

describe("authentication assurance", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const evidence = (level: "password" | "mfa" | "phishing_resistant", minutesAgo: number) => ({ level, method: "password" as const, sessionId: "s", verifiedAt: new Date(now.getTime() - minutesAgo * 60_000) });

  it("derives evidence from the endpoint that created the session", () => {
    expect(assuranceForEndpoint("/sign-in/email")).toEqual({ level: "password", method: "password" });
    expect(assuranceForEndpoint("/two-factor/verify-totp")).toEqual({ level: "mfa", method: "totp" });
    expect(assuranceForEndpoint("/two-factor/verify-backup-code")).toEqual({ level: "mfa", method: "backup_code" });
    expect(assuranceForEndpoint("/passkey/verify-authentication")).toEqual({ level: "phishing_resistant", method: "passkey" });
    expect(securityEventForEndpoint("/passkey/verify-registration")).toBe("security.passkey.added");
    expect(securityEventForEndpoint("/sign-in/email")).toBeNull();
  });

  it("requires level and freshness, never inferring MFA from account settings", () => {
    expect(meetsRequirement(null, { level: "password", maxAgeMinutes: 15 }, now)).toEqual({ ok: false, reason: "missing" });
    expect(meetsRequirement(evidence("password", 1), { level: "mfa", maxAgeMinutes: 15 }, now)).toEqual({ ok: false, reason: "insufficient_level" });
    expect(meetsRequirement(evidence("phishing_resistant", 20), { level: "mfa", maxAgeMinutes: 15 }, now)).toEqual({ ok: false, reason: "stale" });
    expect(meetsRequirement(evidence("phishing_resistant", 5), { level: "mfa", maxAgeMinutes: 15 }, now)).toEqual({ ok: true });
  });

  it("accepts a password locally but requires MFA, and a passkey to grant authority, elsewhere", () => {
    expect(platformAssuranceRequirement("platform.roles.manage", "local").level).toBe("password");
    expect(platformAssuranceRequirement("platform.users.suspend", "staging").level).toBe("mfa");
    expect(platformAssuranceRequirement("platform.roles.manage", "production").level).toBe("phishing_resistant");
    expect(platformAssuranceRequirement("platform.support.enter_tenant", "production").level).toBe("phishing_resistant");
    expect(platformAssuranceRequirement("platform.machine_access.revoke", "production").level).toBe("mfa");
  });
});

describe("enterprise SSO assurance", () => {
  it("records SSO sessions as single-factor evidence", () => {
    for (const path of ["/sso/callback/:providerId", "/sso/saml2/sp/acs/:providerId", "/workos/callback"]) expect(assuranceForEndpoint(path)).toEqual({ level: "password", method: "sso" });
  });
});

describe("credential verifier boundary", () => {
  const credential = { credentialId: "k1", organizationId: "org_1", serviceAccountId: "sa_1", environment: "production" as const, scopes: ["projects.read", "projects.write", "billing.read"], expiresAt: null, revokedAt: null, allowedCidrs: ["10.0.0.0/8"] };
  const context = { now: new Date("2026-09-22T00:00:00Z"), environment: "production" as const, clientIp: "10.1.2.3", required: "projects.read", serviceAccount: { id: "sa_1", organizationId: "org_1", status: "active" as const, authority: new Set(["projects.read", "billing.read"]) } };

  it("intersects key scopes with the service account's authority and the tenant's entitlements", () => {
    expect(credentialAccess(credential, context)).toEqual({ allowed: true, status: "active", effective: ["billing.read", "projects.read"] });
    expect(credentialAccess(credential, { ...context, required: "projects.write" }).allowed).toBe(false);
    expect(credentialAccess(credential, { ...context, entitled: new Set(["projects.read"]) }).effective).toEqual(["projects.read"]);
  });

  it("fails closed on environment, network, principal, and missing provider constraints", () => {
    expect(credentialAccess(credential, { ...context, environment: "staging" }).status).toBe("wrong_environment");
    expect(credentialAccess(credential, { ...context, clientIp: "192.168.1.1" }).status).toBe("network_denied");
    expect(credentialAccess(credential, { ...context, clientIp: null }).allowed).toBe(false);
    expect(credentialAccess({ ...credential, serviceAccountId: "sa_2" }, context).status).toBe("wrong_principal");
    expect(credentialAccess({ ...credential, environment: null }, context)).toEqual({ allowed: false, status: "missing_constraints", effective: [] });
    expect(credentialAccess({ ...credential, revokedAt: context.now }, context).status).toBe("revoked");
  });
});

describe("runtime access catalog", () => {
  const base = { permissions: registry, organization: organizationRoles, application: applicationRoles };
  const exportPermission = { code: "reports.export", name: "Export reports", description: "Download report archives", plane: "application" as const, principals: ["user", "api_key"] as const };

  it("adds grant-only runtime permissions and refuses platform, colliding, or mis-prefixed ones", () => {
    expect(runtimePermissionProblems(registry, exportPermission)).toEqual([]);
    expect(runtimePermissionProblems(registry, { ...exportPermission, code: "resource.read" })).toEqual([expect.stringMatching(/already defined in code/u)]);
    expect(runtimePermissionProblems(registry, { ...exportPermission, code: "platform.secrets.read" })).toEqual(expect.arrayContaining([expect.stringMatching(/reviewed source/u)]));
    expect(runtimePermissionProblems(registry, { ...exportPermission, plane: "organization" })).toEqual(expect.arrayContaining([expect.stringMatching(/organization\./u)]));
    const catalog = buildAccessCatalog(base, { permissions: [exportPermission], roles: [] });
    expect(catalog.permissions.get("reports.export")).toMatchObject({ origin: "runtime", name: "Export reports" });
    expect(catalog.permissions.list("application").some((permission) => permission.code === "resource.read" && permission.origin === "code")).toBe(true);
  });

  it("composes catalog roles in both planes, keeps them through tenant roles, and fails safe", () => {
    const catalog = buildAccessCatalog(base, { permissions: [exportPermission], roles: [
      { key: "analyst", name: "Analyst", description: "Reads and exports", plane: "application", permissions: ["resource.read", "reports.export", "gone.permission"] },
      { key: "auditor", name: "Auditor", description: "Reads the audit log", plane: "organization", permissions: ["organization.audit.read"] },
      { key: "retired", name: "Retired", description: "", plane: "application", permissions: ["resource.read"], archived: true },
    ] });
    expect([...catalog.application.resolve(["analyst"]).permissions.keys()]).toEqual(["reports.export", "resource.read"]);
    expect([...catalog.organization.resolve(["auditor"]).permissions.keys()]).toEqual(["organization.audit.read"]);
    expect(catalog.application.resolve(["retired"]).unknownRoles).toEqual(["retired"]);
    const withTenant = catalog.application.withCustomRoles([{ key: "analyst", name: "Shadow", permissions: ["resource.write"] }, { key: "writer", name: "Writer", permissions: ["resource.write"] }]);
    expect([...withTenant.resolve(["analyst"]).permissions.keys()]).toEqual(["reports.export", "resource.read"]);
    expect(withTenant.get("writer")?.source).toBe("tenant");
    expect(catalogRoleProblems(catalog, { key: "reader", name: "Reader", description: "", plane: "application", permissions: [] }, { creating: true })).toEqual([expect.stringMatching(/built-in/u)]);
    expect(catalogRoleProblems(catalog, { key: "billing", name: "Billing", description: "", plane: "organization", permissions: ["resource.read"] }, { creating: true })).toEqual([expect.stringMatching(/application permission/u)]);
  });
});
