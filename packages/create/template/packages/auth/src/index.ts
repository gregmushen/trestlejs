import { createDatabase, type DatabaseDriver } from "@__TRESTLE_PROJECT_NAME__/db";
import * as schema from "@__TRESTLE_PROJECT_NAME__/db";
import { createEmailService, invitationTemplate, resetPasswordTemplate, verifyEmailTemplate, type R2BucketBinding } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";

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
    })],
  });
}

async function fingerprint(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export type Auth = ReturnType<typeof createAuth>;
