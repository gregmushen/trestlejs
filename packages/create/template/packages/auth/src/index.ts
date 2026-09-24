import { assuranceForEndpoint, memberDefaultApplicationRoles, organizationCreatorApplicationRoles, securityEventForEndpoint } from "@__TRESTLE_PROJECT_NAME__/authz";
import { createLogger } from "@__TRESTLE_PROJECT_NAME__/context";
import { createDatabase, createTenantDatabase, grantApplicationRoles, recordAssurance, sessionAssurance, type Database, type DatabaseDriver } from "@__TRESTLE_PROJECT_NAME__/db";
import * as schema from "@__TRESTLE_PROJECT_NAME__/db";
import { createEmailService, invitationTemplate, resetPasswordTemplate, verifyEmailTemplate, type R2BucketBinding } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { eq, sql } from "drizzle-orm";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { organization, twoFactor } from "better-auth/plugins";

export interface AuthEnvironment {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL?: string;
  DATABASE_DRIVER?: DatabaseDriver;
  EMAIL_DELIVERY_MODE?: "capture" | "local" | "provider" | "resend";
  APP_ENV?: "local" | "preview" | "staging" | "production";
  WEBHOOK_DELIVERY_MODE?: "disabled" | "local" | "native" | "svix";
  WEBHOOK_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  EMAIL_STAGING_REDIRECT?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_MODE?: "local" | "test" | "live";
  STRIPE_PRICES?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  BILLING_RETURN_URL?: string;
  WEB_ORIGIN?: string;
  TRESTLE_ARTIFACTS?: R2BucketBinding;
  ARTIFACT_SIGNING_SECRET?: string;
  ARTIFACT_READY_RETENTION_DAYS?: string;
}

/** `factors` enables TOTP, backup codes, and passkeys; only the admin surface turns it on for now. */
export type AuthOptions = Readonly<{ factors?: boolean }>;

export function createAuth(environment: AuthEnvironment, options: AuthOptions = {}) {
  const baseURL = environment.BETTER_AUTH_URL ?? "http://localhost:42069";
  const webOrigin = environment.WEB_ORIGIN ?? baseURL;
  const email = createEmailService({
    mode: environment.EMAIL_DELIVERY_MODE === "provider" || environment.EMAIL_DELIVERY_MODE === "resend" ? "resend" : "local",
    environment: environment.APP_ENV ?? "local",
    ...(environment.RESEND_API_KEY ? { resendApiKey: environment.RESEND_API_KEY } : {}),
    ...(environment.EMAIL_FROM ? { from: environment.EMAIL_FROM } : {}),
    ...(environment.EMAIL_REPLY_TO ? { replyTo: environment.EMAIL_REPLY_TO } : {}),
    ...(environment.EMAIL_STAGING_REDIRECT ? { stagingRedirect: environment.EMAIL_STAGING_REDIRECT } : {}),
  });
  return betterAuth({
    appName: "__TRESTLE_PROJECT_NAME__",
    baseURL,
    secret: environment.BETTER_AUTH_SECRET,
    trustedOrigins: [baseURL, webOrigin],
    database: drizzleAdapter(createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER), {
      provider: "pg",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => { await email.send({
        to: user.email,
        subject: "Reset your password",
        template: resetPasswordTemplate({ resetUrl: url }),
      }, { idempotencyKey: `password-reset:${await fingerprint(url)}` }); },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => { await email.send({
        to: user.email,
        subject: "Verify your email",
        template: verifyEmailTemplate({ verificationUrl: url }),
      }, { idempotencyKey: `auth-verification:${await fingerprint(url)}` }); },
    },
    hooks: {
      // Audit account-security changes.
      after: createAuthMiddleware(async (context) => {
        const event = securityEventForEndpoint(context.path);
        if (!event) return;
        const actor = context.context.session?.user.id ?? context.context.newSession?.user.id;
        // A failed endpoint leaves its APIError here (better-auth api/dispatch.mjs); a successful one leaves
        // its JSON body, whose own `status` field (for example `{ status: true }`) is not an HTTP status.
        const succeeded = !(context.context.returned instanceof Error);
        if (actor && succeeded) await recordSecurityEvent(createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER), environment, event, actor);
      }),
    },
    databaseHooks: {
      session: {
        create: {
          // Runs right after the new session row is written and, when Better Auth rotates a
          // session, before it deletes the old one (whose assurance row then cascades away).
          after: async (created, context) => {
            await recordSessionAssurance(createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER), created, context?.context.session?.session ?? null, context?.path ?? "");
          },
        },
      },
      user: {
        update: {
          // Enrollment completes when the first code verifies; sign-in challenges never update the user.
          after: async (user, context) => {
            if (context?.path?.startsWith("/two-factor/verify-") && (user as { twoFactorEnabled?: boolean }).twoFactorEnabled) await recordSecurityEvent(createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER), environment, "security.two_factor.enabled", user.id);
          },
        },
      },
    },
    plugins: [organization({
      sendInvitationEmail: async ({ email: address, id, organization: invitedOrganization }) => { await email.send({
        to: address,
        subject: `Join ${invitedOrganization.name}`,
        template: invitationTemplate({ organizationName: invitedOrganization.name, invitationUrl: `${baseURL}/accept-invitation?id=${id}` }),
      }, { idempotencyKey: `organization-invite:${id}` }); },
      // Application roles are separate from membership; these one-time grants follow packages/authz/src/policies.ts.
      organizationHooks: {
        afterCreateOrganization: async ({ organization: created, user }) => {
          await grantMembershipRoles(environment, created.id, user.id, organizationCreatorApplicationRoles, "policy:organization_creator");
        },
        afterAddMember: async ({ organization: joined, user }) => {
          if (memberDefaultApplicationRoles.length === 0) return;
          // Better Auth also adds the creator through this hook, before afterCreateOrganization;
          // an organization's first member is always its creator, whose roles come from that hook.
          if (await memberCount(environment, joined.id) <= 1) return;
          await grantMembershipRoles(environment, joined.id, user.id, memberDefaultApplicationRoles, "policy:member_default");
        },
        afterAcceptInvitation: async ({ organization: joined, user }) => {
          await grantMembershipRoles(environment, joined.id, user.id, memberDefaultApplicationRoles, "policy:member_default");
        },
      },
    }),
    ...(options.factors ? [
      // Passkeys (WebAuthn) bound to the origin serving this auth instance.
      passkey({ rpID: new URL(webOrigin).hostname, rpName: "__TRESTLE_PROJECT_NAME__", origin: webOrigin }),
      // TOTP and backup codes; Better Auth encrypts the secret and codes at rest.
      twoFactor({ issuer: "__TRESTLE_PROJECT_NAME__" }),
    ] : [])],
  });
}

/**
 * Records how a new session was authenticated. Only a session created without a
 * prior one (a sign-in) gets the level its endpoint proves. A session that
 * replaces an authenticated one (two-factor enrollment or disable, which need
 * only the password) inherits the prior session's evidence, so enrolling an
 * authenticator never upgrades a password-only session to MFA.
 */
async function recordSessionAssurance(database: Database, created: Readonly<{ id: string; userId: string }>, prior: Readonly<{ id: string; userId: string }> | null, path: string): Promise<void> {
  try {
    const carried = prior && prior.userId === created.userId && prior.id !== created.id ? await sessionAssurance(database, prior.id) : null;
    const evidence = carried ?? (prior ? { level: "password", method: "password" } as const : assuranceForEndpoint(path));
    await recordAssurance(database, { sessionId: created.id, userId: created.userId, level: evidence.level, method: evidence.method });
  } catch (error) {
    // Fail closed: the session stays usable for ordinary work, but with no assurance row
    // every step-up check reports "missing" and asks the person to verify again.
    createLogger({ surface: "auth" }).error("auth.assurance.record_failed", { errorName: error instanceof Error ? error.name : "unknown" });
  }
}

/** Records an organization-less security.* event through the SECURITY DEFINER function (migration 0032). */
async function recordSecurityEvent(database: Database, environment: AuthEnvironment, name: string, userId: string): Promise<void> {
  // The credential change is already committed when this runs, so a failed audit write is logged, not thrown.
  try {
    await database.execute(sql`select trestle_record_security_event(${name}, ${userId}, ${`auth:${crypto.randomUUID()}`}, ${environment.APP_ENV ?? "local"})`);
  } catch (error) {
    createLogger({ surface: "auth" }).error("security.audit.record_failed", { event: name, errorName: error instanceof Error ? error.name : "unknown" });
  }
}

async function memberCount(environment: AuthEnvironment, organizationId: string): Promise<number> {
  const rows = await createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER).select({ id: schema.member.id }).from(schema.member).where(eq(schema.member.organizationId, organizationId)).limit(2);
  return rows.length;
}

/** Writes on the restricted tenant connection, so forced RLS bounds the grant to this organization. */
async function grantMembershipRoles(environment: AuthEnvironment, organizationId: string, userId: string, roles: readonly string[], grantedBy: string): Promise<void> {
  await grantApplicationRoles(createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId), { organizationId, userId, roles, grantedBy });
}

async function fingerprint(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export type Auth = ReturnType<typeof createAuth>;
