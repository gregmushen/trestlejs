import { memberDefaultApplicationRoles, organizationCreatorApplicationRoles } from "@__TRESTLE_PROJECT_NAME__/authz";
import { createDatabase, createTenantDatabase, grantApplicationRoles, type DatabaseDriver } from "@__TRESTLE_PROJECT_NAME__/db";
import * as schema from "@__TRESTLE_PROJECT_NAME__/db";
import { createEmailService, invitationTemplate, resetPasswordTemplate, verifyEmailTemplate, type R2BucketBinding } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";

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

export function createAuth(environment: AuthEnvironment) {
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
          // Better Auth also adds the creator through this hook, before afterCreateOrganization;
          // an organization's first member is always its creator, whose roles come from that hook.
          if (await memberCount(environment, joined.id) <= 1) return;
          await grantMembershipRoles(environment, joined.id, user.id, memberDefaultApplicationRoles, "policy:member_default");
        },
        afterAcceptInvitation: async ({ organization: joined, user }) => {
          await grantMembershipRoles(environment, joined.id, user.id, memberDefaultApplicationRoles, "policy:member_default");
        },
      },
    })],
  });
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
