import {
  authPolicyImpact,
  authPolicySafeguardProblems,
  authPolicyShapeProblems,
  defaultAuthPolicy,
  forgetAuthPolicy,
  normalizeAuthPolicy,
  type AuthPolicy,
  type AuthPolicyFacts,
} from "@__TRESTLE_PROJECT_NAME__/auth";
import { platformRoles, type ApplicationEnvironment } from "@__TRESTLE_PROJECT_NAME__/authz";
import { PlatformRequestError, type CapabilityStatus, type PlatformAudit, type PostgresPlatformRepository } from "@__TRESTLE_PROJECT_NAME__/platform";
import type { Context, Hono } from "hono";
import { z } from "zod";

/**
 * System -> Authentication (docs/ADMIN_REQUIRED_CHANGES.md §10). One place to
 * understand authentication: effective posture, where each setting comes
 * from, and the runtime policy versions. Safe runtime policy is drafted,
 * validated, reviewed with its impact, activated with a reason and step-up,
 * and rolled back by activating a copy of a previous valid version. Setup-
 * owned settings are shown read-only; secrets are reported only as present.
 */

type Bindings = {
  DATABASE_URL: string; APP_ENV?: ApplicationEnvironment; BETTER_AUTH_URL?: string; WEB_ORIGIN?: string; ADMIN_ORIGIN?: string; BETTER_AUTH_SECRET?: string;
  EMAIL_DELIVERY_MODE?: string; SSO_TRUSTED_ISSUERS?: string; WORKOS_API_KEY?: string; SCIM_CREDENTIAL_SECRET?: string;
};
type Authority = { operator: { id: string }; require(permission: string): void; requireSensitive(permission: string, reason: unknown): string };
type Environment = { Bindings: Bindings; Variables: { authority: Authority; correlationId: string } };
type AuditInput = Omit<PlatformAudit, "actorId" | "environment" | "correlationId" | "now">;
type Dependencies = {
  repository: (environment: Bindings) => PostgresPlatformRepository;
  audit: (context: Context<Environment>, entry: AuditInput) => PlatformAudit;
  capabilities: (context: Context<Environment>) => Promise<CapabilityStatus[]>;
};

const whole = (min: number, max: number) => z.number().int().min(min).max(max);
const policySchema: z.ZodType<AuthPolicy> = z.object({
  signIn: z.object({ password: z.boolean() }).strict(),
  registration: z.object({ mode: z.enum(["open", "invite_only", "closed"]), requireEmailVerification: z.boolean() }).strict(),
  password: z.object({ minLength: whole(8, 128), resetEnabled: z.boolean(), revokeSessionsOnReset: z.boolean() }).strict(),
  mfa: z.object({ trustedDeviceDays: whole(1, 90) }).strict(),
  stepUp: z.object({ windowMinutes: whole(5, 60) }).strict(),
  sessions: z.object({ lifetimeDays: whole(1, 90), refreshHours: whole(1, 168), maxConcurrent: whole(0, 100) }).strict(),
  organizations: z.object({ allowCreation: z.boolean(), limitPerUser: whole(0, 1000), invitationExpiryDays: whole(1, 30), membershipLimit: whole(1, 100_000) }).strict(),
}).strict() as never;
const reason = z.string().trim().min(1).max(500);

async function json<T extends z.ZodType>(context: Context<Environment>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => undefined));
  if (!parsed.success) throw new PlatformRequestError(422, "invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  return parsed.data;
}

/** Roles whose holders can repair authentication; at least one of them must always be able to sign in and recover. */
const guardianRoles = platformRoles.list().filter((role) => role.permissions.includes("platform.auth_policy.manage")).map((role) => role.key);

export function registerAuthPolicyRoutes(admin: Hono<Environment>, dependencies: Dependencies) {
  const repo = (context: Context<Environment>) => dependencies.repository(context.env);
  const environmentOf = (context: Context<Environment>) => context.env.APP_ENV ?? "local";

  async function facts(context: Context<Environment>, statuses: readonly CapabilityStatus[]): Promise<AuthPolicyFacts> {
    const state = (id: string) => statuses.find((status) => status.id === id);
    const installed = (id: string) => Boolean(state(id) && state(id)!.state !== "disabled");
    return {
      environment: environmentOf(context),
      capabilities: { passkeys: installed("passkeys"), twoFactor: installed("twoFactor"), sso: installed("sso") ? state("sso")!.mode ?? "installed" : "disabled" },
      emailHealthy: state("email")?.healthy ?? false,
      platformAdmins: await repo(context).platformAdminFactors(guardianRoles),
    };
  }

  async function load(context: Context<Environment>) {
    const versions = await repo(context).authPolicyVersions();
    const active = versions.find((version) => version.state === "active") ?? null;
    const draft = versions.find((version) => version.state === "draft") ?? null;
    return { versions, active, draft, effective: active ? normalizeAuthPolicy(active.policy) : defaultAuthPolicy };
  }

  /** Where each runtime setting comes from: an active version that sets it, or the Better Auth / Trestle default. */
  const sources = (active: { version: number; policy: Record<string, unknown> } | null) => Object.fromEntries(Object.entries(defaultAuthPolicy).flatMap(([section, values]) =>
    Object.keys(values).map((key) => {
      const set = Boolean(active && (active.policy[section] as Record<string, unknown> | undefined)?.[key] !== undefined);
      return [`${section}.${key}`, set ? `runtime policy v${active!.version}` : section === "stepUp" ? "Trestle default" : "Better Auth default"];
    })));

  function validate(policy: AuthPolicy, known: AuthPolicyFacts) {
    return { shape: authPolicyShapeProblems(policy), safeguards: authPolicySafeguardProblems(policy, known) };
  }

  admin.get("/api/admin/auth-policy", async (context) => {
    context.get("authority").require("platform.auth_policy.read");
    const statuses = await dependencies.capabilities(context);
    const known = await facts(context, statuses);
    const { versions, active, draft, effective } = await load(context);
    const state = (id: string) => statuses.find((status) => status.id === id);
    const draftPolicy = draft ? normalizeAuthPolicy(draft.policy) : null;
    const present = (value: string | undefined) => value ? "configured" : "not configured";
    return context.json({
      environment: environmentOf(context),
      effective: { policy: effective, version: active?.version ?? null, sources: sources(active), problems: authPolicySafeguardProblems(effective, known) },
      // Setup-owned: shown for understanding, changed only through trestle setup or deployment configuration.
      setup: [
        { label: "Passkeys", value: state("passkeys")?.state ?? "not reported", source: "trestle setup", healthy: state("passkeys")?.healthy ?? null },
        { label: "Two-factor (TOTP, email OTP, backup codes)", value: state("twoFactor")?.state ?? "not reported", source: "trestle setup", healthy: state("twoFactor")?.healthy ?? null },
        { label: "Enterprise SSO", value: known.capabilities.sso, source: "trestle setup", healthy: state("sso")?.healthy ?? null },
        { label: "Directory sync (SCIM)", value: state("directory")?.state === "disabled" || !state("directory") ? "disabled" : state("directory")!.mode ?? state("directory")!.state, source: "trestle setup", healthy: state("directory")?.healthy ?? null },
        { label: "Customer auth URL", value: context.env.BETTER_AUTH_URL ?? "http://localhost:42069", source: "environment", healthy: null },
        { label: "Application origin", value: context.env.WEB_ORIGIN ?? context.env.BETTER_AUTH_URL ?? "http://localhost:42069", source: "environment", healthy: null },
        { label: "Admin origin", value: context.env.ADMIN_ORIGIN ?? "http://localhost:42070", source: "environment", healthy: null },
        { label: "Admin session cookies", value: "prefix trestle-admin, separate from customer sessions", source: "trestle setup", healthy: null },
        { label: "Trusted SSO issuers", value: `${(context.env.SSO_TRUSTED_ISSUERS ?? "").split(",").filter((origin) => origin.trim()).length} configured`, source: "environment", healthy: null },
        { label: "Session signing secret", value: present(context.env.BETTER_AUTH_SECRET), source: "environment", healthy: Boolean(context.env.BETTER_AUTH_SECRET) },
        { label: "WorkOS API key", value: present(context.env.WORKOS_API_KEY), source: "environment", healthy: null },
        { label: "SCIM credential secret", value: present(context.env.SCIM_CREDENTIAL_SECRET), source: "environment", healthy: null },
      ],
      email: { mode: state("email")?.mode ?? context.env.EMAIL_DELIVERY_MODE ?? "not reported", healthy: known.emailHealthy, message: state("email")?.message ?? null, flows: ["email verification", "password reset", "invitations", "sign-in codes"] },
      guardians: { roles: guardianRoles, total: known.platformAdmins.length, withPasskey: known.platformAdmins.filter((admin) => admin.passkeys > 0).length, withTwoFactor: known.platformAdmins.filter((admin) => admin.twoFactor).length },
      draft: draft && draftPolicy ? { version: draft.version, basedOn: draft.basedOn, policy: draftPolicy, createdBy: draft.createdBy, createdAt: draft.createdAt, ...validate(draftPolicy, known), impact: authPolicyImpact(effective, draftPolicy) } : null,
      versions: versions.filter((version) => version.state !== "draft").map((version) => ({ ...version, policy: normalizeAuthPolicy(version.policy), impact: authPolicyImpact(effective, normalizeAuthPolicy(version.policy)) })),
      defaults: defaultAuthPolicy,
    });
  });

  admin.post("/api/admin/auth-policy/drafts", async (context) => {
    const input = await json(context, z.object({ reason }).strict());
    const why = context.get("authority").requireSensitive("platform.auth_policy.manage", input.reason);
    const { versions, active, draft, effective } = await load(context);
    if (draft) throw new PlatformRequestError(409, "conflict", `Version ${draft.version} is already a draft`);
    const version = (versions[0]?.version ?? 0) + 1;
    await repo(context).mutate(repo(context).insertAuthPolicyVersion({ version, state: "draft", policy: effective, basedOn: active?.version ?? null }, context.get("authority").operator.id),
      dependencies.audit(context, { name: "security.auth_policy.drafted", organizationId: null, targetType: "auth_policy_version", targetId: String(version), reason: why, summary: { basedOn: active?.version ?? null } }));
    return context.json({ version }, 201);
  });

  // Drafts change nothing until activated, so edits need the permission but no reason or step-up.
  admin.put("/api/admin/auth-policy/draft", async (context) => {
    context.get("authority").require("platform.auth_policy.manage");
    const input = await json(context, z.object({ policy: policySchema }).strict());
    const { draft, effective } = await load(context);
    if (!draft) throw new PlatformRequestError(409, "no_draft", "Create a draft before editing");
    await repo(context).mutate(repo(context).updateAuthPolicyDraft(draft.version, input.policy),
      dependencies.audit(context, { name: "security.auth_policy.draft_revised", organizationId: null, targetType: "auth_policy_version", targetId: String(draft.version), reason: "draft edit", summary: { impact: authPolicyImpact(effective, input.policy) } }));
    return context.json({ ...validate(input.policy, await facts(context, await dependencies.capabilities(context))), impact: authPolicyImpact(effective, input.policy) });
  });

  admin.delete("/api/admin/auth-policy/draft", async (context) => {
    const input = await json(context, z.object({ reason }).strict());
    const why = context.get("authority").requireSensitive("platform.auth_policy.manage", input.reason);
    const { draft } = await load(context);
    if (!draft) throw new PlatformRequestError(409, "no_draft", "There is no draft to discard");
    await repo(context).mutate(repo(context).discardAuthPolicyDraft(draft.version), dependencies.audit(context, { name: "security.auth_policy.draft_discarded", organizationId: null, targetType: "auth_policy_version", targetId: String(draft.version), reason: why, summary: {} }));
    return context.body(null, 204);
  });

  /** Activates the draft, or (rollback) a new version copied from a previous one. Both pass the same safeguards. */
  async function activate(context: Context<Environment>, why: string, target: { draft: number } | { rollbackTo: number }) {
    const { versions, active, draft, effective } = await load(context);
    const source = "draft" in target ? draft && draft.version === target.draft ? draft : null : versions.find((version) => version.version === target.rollbackTo && (version.state === "superseded" || version.state === "active")) ?? null;
    if (!source) throw new PlatformRequestError(404, "not_found", "draft" in target ? "There is no draft to activate" : "That version does not exist");
    if ("rollbackTo" in target && source.state === "active") throw new PlatformRequestError(409, "conflict", `Version ${source.version} is already active`);
    const policy = normalizeAuthPolicy(source.policy);
    const problems = validate(policy, await facts(context, await dependencies.capabilities(context)));
    if (problems.shape.length || problems.safeguards.length) throw new PlatformRequestError(422, "unsafe_policy", [...problems.shape, ...problems.safeguards].join("; "), undefined, { problems: [...problems.shape, ...problems.safeguards] });
    const by = context.get("authority").operator.id;
    const impact = authPolicyImpact(effective, policy);
    if ("draft" in target) {
      await repo(context).mutate(repo(context).activateAuthPolicyDraft(source.version, by, why), dependencies.audit(context, { name: "security.auth_policy.activated", organizationId: null, targetType: "auth_policy_version", targetId: String(source.version), reason: why, summary: { previous: active?.version ?? null, impact } }));
    } else {
      const version = (versions[0]?.version ?? 0) + 1;
      await repo(context).mutate(repo(context).insertAuthPolicyVersion({ version, state: "active", policy, basedOn: source.version, reason: why }, by), dependencies.audit(context, { name: "security.auth_policy.rolled_back", organizationId: null, targetType: "auth_policy_version", targetId: String(version), reason: why, summary: { previous: active?.version ?? null, restores: source.version, impact } }));
    }
    // This isolate applies it now; others within the policy cache window.
    forgetAuthPolicy(context.env);
    return impact;
  }

  admin.post("/api/admin/auth-policy/draft/activate", async (context) => {
    const input = await json(context, z.object({ reason }).strict());
    const why = context.get("authority").requireSensitive("platform.auth_policy.manage", input.reason);
    const { draft } = await load(context);
    return context.json({ impact: await activate(context, why, { draft: draft?.version ?? -1 }) });
  });

  admin.post("/api/admin/auth-policy/versions/:version/rollback", async (context) => {
    const input = await json(context, z.object({ reason }).strict());
    const why = context.get("authority").requireSensitive("platform.auth_policy.manage", input.reason);
    return context.json({ impact: await activate(context, why, { rollbackTo: Number(context.req.param("version")) }) });
  });
}
