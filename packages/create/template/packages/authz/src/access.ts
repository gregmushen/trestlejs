import type { AuthorityPlane, PermissionRegistry } from "./registry.js";
import type { EffectivePermissions } from "./roles.js";

/** Identity types. A platform operator is a user with platform-role assignments, not an identity type. */
export type PrincipalType = "user" | "service_account" | "system";
export type AccessPrincipal = Readonly<{ type: PrincipalType; id: string; label?: string }>;
export type CredentialStatus = "active" | "revoked" | "expired" | "wrong_environment" | "network_denied" | "service_account_suspended";

export type EntitlementGrant = Readonly<{ code: string; enabled: boolean; source: string; inheritedFrom?: string }>;
export interface EntitlementSource {
  get(code: string): EntitlementGrant | undefined;
}

export type AccessConstraint = Readonly<{ name: string; expected: string; actual: string; satisfied: boolean }>;

export type AccessSubject = Readonly<{
  principal: AccessPrincipal;
  tenant?: Readonly<{ organizationId: string; label?: string }>;
  /** Actor authority per plane. A missing plane means no authority in it. */
  authority: Readonly<Partial<Record<AuthorityPlane, EffectivePermissions>>>;
  /** Role assignments considered, per plane, for explanation. */
  assignments?: Readonly<Partial<Record<AuthorityPlane, readonly string[]>>>;
  /** Present only for API-key requests. A key without scopes has no authority. */
  scopes?: ReadonlySet<string>;
  credential?: Readonly<{ id: string; status: CredentialStatus }>;
  /** Commercial authority: the tenant's effective entitlements. */
  entitlements?: EntitlementSource;
  constraints?: readonly AccessConstraint[];
}>;

export type AccessRequirement = Readonly<{ permission?: string; entitlement?: string; rejectApiKeys?: boolean }>;

export type AccessReason =
  | "allowed"
  | "unknown_permission"
  | "principal_type_rejected"
  | "credential_inactive"
  | "tenant_required"
  | "entitlement_missing"
  | "permission_missing"
  | "scope_missing"
  | "constraint_failed";

export type AccessDecision = Readonly<{
  allowed: boolean;
  reason: AccessReason;
  principal: AccessPrincipal;
  tenant?: Readonly<{ organizationId: string; label?: string }>;
  entitlement?: Readonly<{ code: string; enabled: boolean; source?: string; inheritedFrom?: string }>;
  permission?: Readonly<{ code: string; plane: AuthorityPlane; granted: boolean; grantedBy: readonly string[] }>;
  assignments: Readonly<Record<AuthorityPlane, readonly string[]>>;
  scope?: Readonly<{ code: string; present: boolean }>;
  credential?: Readonly<{ id: string; status: CredentialStatus }>;
  constraints: readonly AccessConstraint[];
}>;

const httpStatus: Record<Exclude<AccessReason, "allowed">, 400 | 401 | 403 | 500> = {
  unknown_permission: 500,
  principal_type_rejected: 403,
  credential_inactive: 401,
  tenant_required: 400,
  entitlement_missing: 403,
  permission_missing: 403,
  scope_missing: 403,
  constraint_failed: 403,
};

export class AccessDeniedError extends Error {
  readonly status: 400 | 401 | 403 | 500;
  constructor(readonly decision: AccessDecision) {
    super(`Access denied: ${decision.reason}`);
    this.name = "AccessDeniedError";
    this.status = decision.reason === "allowed" ? 403 : httpStatus[decision.reason];
  }
}

export function evaluateAccess(registry: PermissionRegistry, subject: AccessSubject, requirement: AccessRequirement): AccessDecision {
  const failures: AccessReason[] = [];
  const definition = requirement.permission ? registry.get(requirement.permission) : undefined;
  if (requirement.permission && !definition) failures.push("unknown_permission");

  const machine = subject.principal.type === "service_account";
  if (definition && subject.principal.type !== "system" && !definition.principals.includes(machine ? "api_key" : "user")) failures.push("principal_type_rejected");
  if (machine && requirement.rejectApiKeys) failures.push("principal_type_rejected");
  if (subject.credential && subject.credential.status !== "active") failures.push("credential_inactive");

  const plane = definition?.plane;
  const entitlementCode = requirement.entitlement ?? (plane !== "platform" ? definition?.entitlement : undefined);
  const needsTenant = Boolean(entitlementCode) || plane === "organization" || plane === "application";
  if (needsTenant && !subject.tenant) failures.push("tenant_required");

  const grant = entitlementCode ? subject.entitlements?.get(entitlementCode) : undefined;
  const entitlement = entitlementCode
    ? { code: entitlementCode, enabled: Boolean(grant?.enabled), ...(grant ? { source: grant.source } : {}), ...(grant?.inheritedFrom ? { inheritedFrom: grant.inheritedFrom } : {}) }
    : undefined;
  if (entitlement && !entitlement.enabled) failures.push("entitlement_missing");

  const grantedBy = requirement.permission && plane ? subject.authority[plane]?.get(requirement.permission) ?? [] : [];
  const permission = requirement.permission && plane ? { code: requirement.permission, plane, granted: grantedBy.length > 0, grantedBy } : undefined;
  if (requirement.permission && !permission?.granted && !failures.includes("unknown_permission")) failures.push("permission_missing");

  const scope = machine && requirement.permission ? { code: requirement.permission, present: subject.scopes?.has(requirement.permission) ?? false } : undefined;
  if (scope && !scope.present) failures.push("scope_missing");

  const constraints = subject.constraints ?? [];
  if (constraints.some((constraint) => !constraint.satisfied)) failures.push("constraint_failed");

  const order: AccessReason[] = ["unknown_permission", "credential_inactive", "principal_type_rejected", "tenant_required", "entitlement_missing", "permission_missing", "scope_missing", "constraint_failed"];
  const reason = order.find((candidate) => failures.includes(candidate)) ?? "allowed";
  return {
    allowed: reason === "allowed",
    reason,
    principal: subject.principal,
    ...(subject.tenant ? { tenant: subject.tenant } : {}),
    ...(entitlement ? { entitlement } : {}),
    ...(permission ? { permission } : {}),
    ...(scope ? { scope } : {}),
    ...(subject.credential ? { credential: subject.credential } : {}),
    assignments: { organization: subject.assignments?.organization ?? [], application: subject.assignments?.application ?? [], platform: subject.assignments?.platform ?? [] },
    constraints,
  };
}

export class AccessEvaluator {
  constructor(private readonly registry: PermissionRegistry, private readonly subject: AccessSubject) {}
  explain(requirement: AccessRequirement): AccessDecision { return evaluateAccess(this.registry, this.subject, requirement); }
  check(requirement: AccessRequirement): boolean { return this.explain(requirement).allowed; }
  require(requirement: AccessRequirement): AccessDecision {
    const decision = this.explain(requirement);
    if (!decision.allowed) throw new AccessDeniedError(decision);
    return decision;
  }
  /** Codes this subject could exercise if the endpoint requires only that permission. */
  permitted(): string[] {
    return this.registry.list().map(({ code }) => code).filter((code) => this.check({ permission: code }));
  }
}

/** Response body safe for the caller: stable reason code plus upgrade path for missing entitlements. */
export function publicDenial(decision: AccessDecision): { error: string; reason: AccessReason; entitlement?: string } {
  if (decision.reason === "entitlement_missing" && decision.entitlement) return { error: "entitlement_required", reason: decision.reason, entitlement: decision.entitlement.code };
  if (decision.reason === "credential_inactive") return { error: "unauthorized", reason: decision.reason };
  if (decision.reason === "tenant_required") return { error: "tenant_required", reason: decision.reason };
  return { error: "forbidden", reason: decision.reason };
}

const planeLabel: Record<AuthorityPlane, string> = { organization: "Organization", application: "Application", platform: "Platform" };

export function formatAccessExplanation(decision: AccessDecision): string {
  const rows: Array<[string, string, string]> = [["Identity", decision.principal.label ?? decision.principal.id, decision.principal.type === "service_account" ? "service account" : decision.principal.type]];
  if (decision.tenant) rows.push(["Organization", decision.tenant.label ?? decision.tenant.organizationId, decision.principal.type === "service_account" ? "owning tenant" : "selected tenant"]);
  for (const plane of ["organization", "application", "platform"] as const) {
    const roles = decision.assignments[plane];
    rows.push([`${planeLabel[plane]} role`, roles.length ? roles.join(", ") : "none", roles.length ? `${plane} authority only` : `no ${plane} authority`]);
  }
  if (decision.permission) rows.push([`${planeLabel[decision.permission.plane]} permission`, decision.permission.code, decision.permission.granted ? `granted by ${decision.permission.grantedBy.join(", ")}` : "not granted"]);
  if (decision.entitlement) rows.push(["Entitlement", decision.entitlement.code, decision.entitlement.enabled ? `enabled by ${decision.entitlement.inheritedFrom ?? decision.entitlement.source ?? "grant"}` : "missing"]);
  if (decision.scope) rows.push(["API-key scope", decision.scope.code, decision.scope.present ? "present" : "missing"]);
  for (const constraint of decision.constraints) rows.push([constraint.name, constraint.actual, constraint.satisfied ? "matched" : `expected ${constraint.expected}`]);
  if (decision.credential) rows.push(["Key status", decision.credential.status, decision.credential.status === "active" ? "valid" : "invalid"]);
  const table = rows.map(([label, value, detail]) => `${label.padEnd(24)}${value.padEnd(22)}${detail}`.trimEnd());
  return [...table, "-".repeat(74), `${"Decision".padEnd(24)}${decision.allowed ? "ALLOWED" : `DENIED (${decision.reason})`}`].join("\n");
}
