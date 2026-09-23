import { AccessEvaluator, meetsRequirement, permissions, platformAssuranceRequirement, platformRoles, type AccessDecision, type ApplicationEnvironment, type AuthenticationAssurance } from "@__TRESTLE_PROJECT_NAME__/authz";

export type Operator = Readonly<{ id: string; email: string; name: string }>;

export class PlatformRequestError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 428, readonly code: string, message: string, readonly decision?: AccessDecision, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "PlatformRequestError";
  }
}

/** Sensitive platform actions require fresh assurance evidence (docs/INTEGRATION_STRATEGY.md §3.2). */
export const stepUpWindowMinutes = 15;

/**
 * Platform authority for one operator: only platform-plane permissions from
 * explicit platform-role assignments. Organization and application
 * assignments the same user may hold are never consulted.
 */
export class PlatformAuthority {
  readonly roles: readonly string[];
  readonly evaluator: AccessEvaluator;

  constructor(readonly operator: Operator, assignedRoles: readonly string[], readonly assurance: AuthenticationAssurance | null, private readonly now: () => Date = () => new Date(), private readonly environment: ApplicationEnvironment = "local", private readonly stepUpMinutes: number = stepUpWindowMinutes) {
    const { permissions: granted, unknownRoles } = platformRoles.resolve(assignedRoles);
    this.roles = [...assignedRoles].filter((role) => !unknownRoles.includes(role)).sort();
    this.evaluator = new AccessEvaluator(permissions, { principal: { type: "user", id: operator.id, label: operator.email }, authority: { platform: granted }, assignments: { platform: this.roles } });
  }

  get permissions(): string[] { return this.evaluator.permitted(); }
  /** When the current evidence stops satisfying the freshness window. */
  get stepUpRequiredAfter(): Date { return new Date((this.assurance?.verifiedAt.getTime() ?? 0) + this.stepUpMinutes * 60_000); }

  require(permission: string): AccessDecision {
    const decision = this.evaluator.explain({ permission });
    if (!decision.allowed) throw new PlatformRequestError(403, "forbidden", `The ${permission} platform permission is required`, decision);
    return decision;
  }

  /**
   * Permission + audit reason + assurance evidence of the required level and
   * freshness, for every sensitive or destructive action. Account settings
   * such as `twoFactorEnabled` are never taken as evidence.
   */
  requireSensitive(permission: string, reason: unknown): string {
    this.require(permission);
    const text = typeof reason === "string" ? reason.trim() : "";
    if (!text || text.length > 500) throw new PlatformRequestError(422, "reason_required", "A reason of at most 500 characters is required");
    // The level is fixed by the permission; the freshness window comes from the active authentication policy.
    const requirement = { ...platformAssuranceRequirement(permission, this.environment), maxAgeMinutes: this.stepUpMinutes };
    const result = meetsRequirement(this.assurance, requirement, this.now());
    if (!result.ok) {
      const how = requirement.level === "phishing_resistant" ? "with a passkey" : requirement.level === "mfa" ? "with a second factor" : "with your password";
      throw new PlatformRequestError(428, "step_up_required", `Re-authenticate ${how} to perform this action`, undefined, { required: requirement.level, maxAgeMinutes: requirement.maxAgeMinutes, reason: result.reason, current: this.assurance?.level ?? null });
    }
    return text;
  }
}
