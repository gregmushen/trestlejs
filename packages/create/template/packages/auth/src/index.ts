import { createLogger } from "@__TRESTLE_PROJECT_NAME__/context";
import { PostgresTenantAccessRepository } from "@__TRESTLE_PROJECT_NAME__/data";
import { applicationConnectionString, createDatabase, createSqlRunner, type DatabaseDriver } from "@__TRESTLE_PROJECT_NAME__/db";
import { applyOrganizationCreatorAssignments } from "@__TRESTLE_PROJECT_NAME__/domain";
import * as schema from "@__TRESTLE_PROJECT_NAME__/db";
import { eq, sql } from "drizzle-orm";
import { createEmailService, invitationTemplate, resetPasswordTemplate, securityAlertTemplate, verifyEmailTemplate, type R2BucketBinding } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization, twoFactor } from "better-auth/plugins";
import { createAuthMiddleware } from "better-auth/api";
import { passkey } from "@better-auth/passkey";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";

import { assuranceForEndpoint, securityEventForEndpoint } from "@__TRESTLE_PROJECT_NAME__/authz";

import { resolveScimUser, scimProjection, trestleDirectoryModels } from "./directory.js";
import { cachedAuthPolicy, type AuthPolicy } from "./policy.js";
import { workosSso } from "./workos.js";

export { decodeGrant, encodeGrant } from "./directory.js";
export * from "./policy.js";

export interface AuthEnvironment {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL?: string;
  DATABASE_DRIVER?: DatabaseDriver;
  EMAIL_DELIVERY_MODE?: "capture" | "local" | "provider" | "resend";
  APP_ENV?: "local" | "preview" | "staging" | "production";
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
  /** Encrypts webhook signing secrets at rest. Local and preview fall back to a key derived from BETTER_AUTH_SECRET. */
  WEBHOOK_SECRET_KEY?: string;
  WORKOS_API_KEY?: string;
  WORKOS_CLIENT_ID?: string;
  WORKOS_WEBHOOK_SECRET?: string;
  /** Overrides the WorkOS API origin (tests and regional endpoints only). */
  WORKOS_API_URL?: string;
  /** HMAC key for managed SCIM credentials (32+ characters). Local and preview derive one from BETTER_AUTH_SECRET. */
  SCIM_CREDENTIAL_SECRET?: string;
  /** Comma-separated origins of self-hosted identity providers that may resolve to private addresses. */
  SSO_TRUSTED_ISSUERS?: string;
  OPENMETER_API_KEY?: string;
  OPENMETER_URL?: string;
  LAGO_API_KEY?: string;
  LAGO_API_URL?: string;
  SVIX_API_KEY?: string;
  /** Self-hosted or regional Svix server; defaults to the hosted API. */
  SVIX_SERVER_URL?: string;
}

/** Declared identity choices (.trestle/project.yaml authentication and identity). */
export type AuthCapabilities = Readonly<{
  passkeys: boolean;
  twoFactor: boolean;
  sso: "disabled" | "better-auth" | "workos";
  directory: "disabled" | "better-auth-scim" | "workos";
}>;

export const defaultAuthCapabilities: AuthCapabilities = { passkeys: true, twoFactor: true, sso: "disabled", directory: "disabled" };

/** Better Auth routes Trestle wraps with its own permission check, audit, and outbox (apps/worker identity routes). */
export const trestleWrappedAuthPaths = ["/sso/register", "/sso/update-provider", "/sso/delete-provider", "/sso/request-domain-verification", "/sso/verify-domain", "/sso/providers", "/sso/get-provider"];

/** The managed SCIM credential digest key, or null when SCIM cannot run in this environment. */
export function scimCredentialSecret(environment: AuthEnvironment): string | null {
  if (environment.SCIM_CREDENTIAL_SECRET && environment.SCIM_CREDENTIAL_SECRET.length >= 32) return environment.SCIM_CREDENTIAL_SECRET;
  const runtime = environment.APP_ENV ?? "local";
  return runtime === "local" || runtime === "preview" ? `scim-credential-digest:${environment.BETTER_AUTH_SECRET}`.padEnd(40, "#") : null;
}

/** SCIM and SSO user resolution need interactive transactions; neon-http cannot provide them. */
export const supportsNativeTransactions = (environment: AuthEnvironment) => (environment.DATABASE_DRIVER ?? "neon-http") === "postgres-js";

/** The application's email boundary: provider selection, staging redirects, and payload-free delivery records. */
export function createApplicationEmail(environment: AuthEnvironment) {
  const emailLog = createLogger({ component: "email" });
  return createEmailService({
    mode: environment.EMAIL_DELIVERY_MODE === "provider" || environment.EMAIL_DELIVERY_MODE === "resend" ? "resend" : "local",
    environment: environment.APP_ENV ?? "local",
    ...(environment.RESEND_API_KEY ? { resendApiKey: environment.RESEND_API_KEY } : {}),
    ...(environment.EMAIL_FROM ? { from: environment.EMAIL_FROM } : {}),
    ...(environment.EMAIL_REPLY_TO ? { replyTo: environment.EMAIL_REPLY_TO } : {}),
    ...(environment.EMAIL_STAGING_REDIRECT ? { stagingRedirect: environment.EMAIL_STAGING_REDIRECT } : {}),
    logger: (event, fields) => { if (event === "email.delivery.record_failed" || event === "email.send.failed") emailLog.warn(event, fields); },
    // Operators see template, masked recipient, and status in apps/admin; never content.
    deliverySink: async (record) => {
      await createSqlRunner(applicationConnectionString(environment.DATABASE_URL), environment.DATABASE_DRIVER).query(sql`insert into email_delivery (id, provider, template, recipient_masked, recipient_count, status, failure_category, correlation_id, organization_id)
        values (${record.id}, ${record.provider}, ${record.template}, ${record.recipient}, ${record.recipientCount}, ${record.status}, ${record.failureCategory ?? null}, ${record.correlationId ?? null}, ${record.organizationId ?? null})`);
    },
  });
}

/**
 * `cookiePrefix` separates surfaces that share a host: cookies ignore ports, so
 * locally the admin (:42070) would otherwise receive customer (:42069) sessions.
 */
export function createAuth(environment: AuthEnvironment, options: Readonly<{ cookiePrefix?: string; capabilities?: AuthCapabilities; policy?: AuthPolicy }> = {}) {
  const capabilities = options.capabilities ?? defaultAuthCapabilities;
  // The active runtime policy (System -> Authentication); load it with loadAuthPolicy() before each request.
  const policy = options.policy ?? cachedAuthPolicy(environment);
  const runtime = environment.APP_ENV ?? "local";
  const transactional = supportsNativeTransactions(environment);
  const scimSecret = capabilities.directory === "better-auth-scim" && transactional ? scimCredentialSecret(environment) : null;
  const workosConfigured = capabilities.sso === "workos" && Boolean(environment.WORKOS_API_KEY && environment.WORKOS_CLIENT_ID);
  const trustedIssuers = (environment.SSO_TRUSTED_ISSUERS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  const baseURL = environment.BETTER_AUTH_URL ?? "http://localhost:42069";
  const webOrigin = environment.WEB_ORIGIN ?? baseURL;
  const email = createApplicationEmail(environment);
  const emailLog = createLogger({ component: "auth" });
  const appName = "__TRESTLE_PROJECT_NAME__";
  // Security events go through a SECURITY DEFINER function, never with secrets, codes, or credential material.
  const recordSecurityEvent = (event: string, actor: string) => createSqlRunner(applicationConnectionString(environment.DATABASE_URL), environment.DATABASE_DRIVER)
    .query(sql`select trestle_record_security_event(${event}, ${actor}, ${"{}"}, ${crypto.randomUUID()}, ${environment.APP_ENV ?? "local"})`)
    .then(() => undefined)
    .catch((error: unknown) => emailLog.warn("security.audit.record_failed", { event, errorName: error instanceof Error ? error.name : "UnknownError" }));
  const day = 24 * 60 * 60;
  return betterAuth({
    appName: "__TRESTLE_PROJECT_NAME__",
    session: { expiresIn: policy.sessions.lifetimeDays * day, updateAge: policy.sessions.refreshHours * 60 * 60 },
    baseURL,
    secret: environment.BETTER_AUTH_SECRET,
    trustedOrigins: [baseURL, webOrigin, ...trustedIssuers],
    ...(capabilities.sso === "better-auth" ? { disabledPaths: trestleWrappedAuthPaths } : {}),
    hooks: {
      // Invite-only registration: sign-up needs a pending, unexpired invitation for the address.
      before: createAuthMiddleware(async (context) => {
        if (context.path !== "/sign-up/email" || policy.registration.mode !== "invite_only") return;
        const address = String((context.body as { email?: unknown } | undefined)?.email ?? "").trim().toLowerCase();
        const [invited] = address ? await createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER).select({ id: schema.invitation.id }).from(schema.invitation)
          .where(sql`lower(${schema.invitation.email}) = ${address} and ${schema.invitation.status} = 'pending' and ${schema.invitation.expiresAt} > now()`).limit(1) : [];
        if (!invited) throw APIError.from("FORBIDDEN", { message: "Sign-up requires an invitation", code: "INVITATION_REQUIRED" });
      }),
      // Record how each new session was authenticated, and audit factor changes.
      after: createAuthMiddleware(async (context) => {
        const created = context.context.newSession;
        if (created) {
          const { level, method } = assuranceForEndpoint(context.path);
          await createSqlRunner(environment.DATABASE_URL, environment.DATABASE_DRIVER).query(sql`insert into authentication_assurance (session_id, user_id, level, method, verified_at)
            values (${created.session.id}, ${created.user.id}, ${level}, ${method}, now())
            on conflict (session_id) do update set level = excluded.level, method = excluded.method, verified_at = excluded.verified_at`);
        }
        const event = securityEventForEndpoint(context.path);
        const actor = context.context.session?.user.id ?? created?.user.id;
        const returned = context.context.returned as { status?: number } | undefined;
        if (event && actor && !(returned instanceof Error) && (returned?.status ?? 200) < 400) await recordSecurityEvent(event, actor);
      }),
    },
    ...(options.cookiePrefix ? { advanced: { cookiePrefix: options.cookiePrefix } } : {}),
    database: drizzleAdapter(createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER), {
      provider: "pg",
      schema,
      // Interactive transactions where the driver has them (SCIM requires them; SSO resolution relies on them).
      transaction: transactional,
    }),
    databaseHooks: {
      user: {
        update: {
          // Enrollment completes when the first code verifies; sign-in challenges never update the user.
          after: async (user, context) => {
            if (context?.path.startsWith("/two-factor/verify-") && (user as { twoFactorEnabled?: boolean }).twoFactorEnabled) await recordSecurityEvent("security.two_factor.enabled", user.id);
          },
        },
      },
      session: {
        create: {
          // Platform suspension (apps/admin) takes effect at the next session boundary.
          before: async (session) => {
            const [record] = await createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER).select({ suspendedAt: schema.user.suspendedAt }).from(schema.user).where(eq(schema.user.id, session.userId)).limit(1);
            if (record?.suspendedAt) throw APIError.from("FORBIDDEN", { message: "This account is suspended", code: "ACCOUNT_SUSPENDED" });
          },
          // Concurrency: keep the newest sessions and revoke the oldest beyond the policy limit.
          after: async (session) => {
            if (!policy.sessions.maxConcurrent) return;
            await createSqlRunner(environment.DATABASE_URL, environment.DATABASE_DRIVER).query(sql`delete from session where user_id = ${session.userId} and id in (
              select id from session where user_id = ${session.userId} and expires_at > now() order by created_at desc offset ${policy.sessions.maxConcurrent})`);
          },
        },
      },
    },
    emailAndPassword: {
      enabled: policy.signIn.password,
      disableSignUp: policy.registration.mode === "closed",
      requireEmailVerification: policy.registration.requireEmailVerification,
      minPasswordLength: policy.password.minLength,
      revokeSessionsOnPasswordReset: policy.password.revokeSessionsOnReset,
      // Without a sender Better Auth refuses reset requests, which is how the policy turns reset off.
      ...(policy.password.resetEnabled ? { sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => { await email.send({
        to: user.email,
        subject: "Reset your password",
        template: resetPasswordTemplate({ resetUrl: url }),
      }, { idempotencyKey: `password-reset:${await fingerprint(url)}` }); } } : {}),
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
    plugins: [
      // Passkeys: WebAuthn/FIDO2 platform authenticators and security keys, bound to this origin.
      ...(capabilities.passkeys ? [passkey({ rpID: new URL(webOrigin).hostname, rpName: appName, origin: webOrigin })] : []),
      // TOTP, emailed OTP, and backup codes. Better Auth encrypts the secret and codes at rest.
      ...(capabilities.twoFactor ? [twoFactor({
        issuer: appName,
        trustDeviceMaxAge: policy.mfa.trustedDeviceDays * day,
        otpOptions: {
          sendOTP: async ({ user, otp }) => { await email.send({ to: user.email, subject: "Your sign-in code", template: securityAlertTemplate({ summary: `Your sign-in code is ${otp}. It expires in a few minutes.`, occurredAt: new Date() }) }, { idempotencyKey: `two-factor-otp:${await fingerprint(`${user.id}:${otp}`)}` }); },
        },
      })] : []),
      // Self-hosted enterprise SSO (OIDC and SAML). Outside local, a provider must prove its
      // domain (DNS TXT) before anyone can sign in through it or be linked by email.
      ...(capabilities.sso === "better-auth" ? [sso({
        domainVerification: { enabled: runtime !== "local" },
        organizationProvisioning: { disabled: false, defaultRole: "member" },
        trustEmailVerified: false,
      })] : []),
      ...(workosConfigured ? [workosSso({ apiKey: environment.WORKOS_API_KEY!, clientId: environment.WORKOS_CLIENT_ID!, databaseUrl: environment.DATABASE_URL, ...(environment.DATABASE_DRIVER ? { driver: environment.DATABASE_DRIVER } : {}), ...(environment.WORKOS_API_URL ? { baseUrl: environment.WORKOS_API_URL } : {}) })] : []),
      // Inbound SCIM 2.0 provisioning into the Trestle organization (the provisioning domain).
      // The SCIM plugin's declared schema type does not satisfy exactOptionalPropertyTypes; its runtime shape does.
      ...(scimSecret ? [trestleDirectoryModels(), scim({
        connections: [],
        managedConnections: { credentialHashSecret: scimSecret },
        identity: { resolveUser: (input, context) => resolveScimUser(input, context, runtime !== "local") },
        projection: scimProjection({ environment: runtime }),
      }) as unknown as BetterAuthPlugin] : []),
      organization({
      allowUserToCreateOrganization: policy.organizations.allowCreation,
      ...(policy.organizations.limitPerUser ? { organizationLimit: policy.organizations.limitPerUser } : {}),
      invitationExpiresIn: policy.organizations.invitationExpiryDays * day,
      membershipLimit: policy.organizations.membershipLimit,
      schema: { member: { additionalFields: { roleSource: { type: "string", required: false, input: false } } } },
      organizationHooks: {
        // Explicit cross-plane policy (packages/authz/src/policies.ts): the creator also
        // receives the application-admin assignment. Owner alone grants no product authority.
        afterCreateOrganization: async ({ organization: created, user }) => {
          await applyOrganizationCreatorAssignments(new PostgresTenantAccessRepository(environment.DATABASE_URL, environment.DATABASE_DRIVER, created.id), {
            organizationId: created.id, actor: { type: "user", id: user.id }, correlationId: crypto.randomUUID(), environment: environment.APP_ENV ?? "local", now: new Date(),
          }, user.id);
        },
      },
      sendInvitationEmail: async ({ email: address, id, organization: invitedOrganization }) => { await email.send({
        to: address,
        subject: `Join ${invitedOrganization.name}`,
        template: invitationTemplate({ organizationName: invitedOrganization.name, invitationUrl: `${baseURL}/accept-invitation?id=${id}` }),
      }, { idempotencyKey: `organization-invite:${id}` }); },
    })],
  });
}

async function fingerprint(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export type Auth = ReturnType<typeof createAuth>;

export type ScimScope = "scim.users.read" | "scim.users.write" | "scim.groups.read" | "scim.groups.write";
export type ScimManagedConnection = Readonly<{ connectionId: string; provisioningDomainId: string; status: string; createdAt: Date; createdBy: string }>;
export type ScimManagedCredential = Readonly<{ credentialId: string; status: string; scopes: readonly ScimScope[]; expiresAt: Date; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }>;

/** The SCIM plugin's server-only management calls. Trestle routes check permissions and audit around each one. */
export type ScimManagementApi = {
  createSCIMManagedConnection(input: { body: { scopes: readonly ScimScope[]; expiresAt: Date; creationRequestId: string; provisioningDomainId: string; actorId: string } }): Promise<{ connection: ScimManagedConnection; credential: ScimManagedCredential; token: string }>;
  listSCIMManagedConnections(input: { body: { provisioningDomainId: string } }): Promise<{ connections: ScimManagedConnection[] }>;
  getSCIMManagedConnection(input: { body: { connectionId: string; provisioningDomainId: string } }): Promise<{ connection: ScimManagedConnection; credentials: ScimManagedCredential[] }>;
  rotateSCIMManagedCredential(input: { body: { scopes: readonly ScimScope[]; expiresAt: Date; connectionId: string; provisioningDomainId: string; actorId: string } }): Promise<{ connection: ScimManagedConnection; credential: ScimManagedCredential; token: string }>;
  revokeSCIMManagedCredential(input: { body: { connectionId: string; provisioningDomainId: string; credentialId: string; actorId: string } }): Promise<{ connection: ScimManagedConnection; credentials: ScimManagedCredential[] }>;
  decommissionSCIMManagedConnection(input: { body: { connectionId: string; provisioningDomainId: string; actorId: string } }): Promise<{ connection: ScimManagedConnection }>;
};

export function scimManagement(auth: Auth): ScimManagementApi | null {
  const api = auth.api as unknown as Partial<ScimManagementApi>;
  return typeof api.createSCIMManagedConnection === "function" ? api as ScimManagementApi : null;
}
