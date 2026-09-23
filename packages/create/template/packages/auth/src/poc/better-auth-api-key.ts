/**
 * PROOF OF CONCEPT ONLY (docs/API_KEY_POC.md). Better Auth's API Key plugin
 * behind Trestle's CredentialVerifier port. Nothing in the runtime imports
 * this module; Trestle's own verifier stays authoritative until every gate in
 * the proof of concept passes.
 */
import { apiKey } from "@better-auth/api-key";
import type { CredentialVerifier, IssueCredential, IssuedSecret, VerifiedCredential } from "@__TRESTLE_PROJECT_NAME__/authz";
import * as schema from "@__TRESTLE_PROJECT_NAME__/db";
import { createDatabase, type DatabaseDriver } from "@__TRESTLE_PROJECT_NAME__/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Created and dropped by the proof of concept itself; never part of a Trestle migration. */
export const pocApiKeyTableName = "poc_better_auth_apikey";
export const pocApiKey = pgTable(pocApiKeyTableName, {
  id: text("id").primaryKey(),
  configId: text("config_id").notNull(),
  name: text("name"),
  start: text("start"),
  referenceId: text("reference_id").notNull(),
  prefix: text("prefix"),
  key: text("key").notNull(),
  refillInterval: integer("refill_interval"),
  refillAmount: integer("refill_amount"),
  lastRefillAt: timestamp("last_refill_at", { withTimezone: true }),
  enabled: boolean("enabled"),
  rateLimitEnabled: boolean("rate_limit_enabled"),
  rateLimitTimeWindow: integer("rate_limit_time_window"),
  rateLimitMax: integer("rate_limit_max"),
  requestCount: integer("request_count"),
  remaining: integer("remaining"),
  lastRequest: timestamp("last_request", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  permissions: text("permissions"),
  metadata: text("metadata"),
});

export const pocApiKeyDdl = `create table if not exists ${pocApiKeyTableName} (
  id text primary key, config_id text not null, name text, start text, reference_id text not null, prefix text, key text not null,
  refill_interval integer, refill_amount integer, last_refill_at timestamptz, enabled boolean, rate_limit_enabled boolean, rate_limit_time_window integer,
  rate_limit_max integer, request_count integer, remaining integer, last_request timestamptz, expires_at timestamptz, created_at timestamptz not null,
  updated_at timestamptz not null, permissions text, metadata text)`;

export function createApiKeyPocAuth(databaseUrl: string, driver: DatabaseDriver, options: Readonly<{ disabledPaths?: string[] }> = {}) {
  return betterAuth({
    baseURL: "http://localhost:42069",
    secret: "api-key-proof-of-concept-secret-0123456789",
    database: drizzleAdapter(createDatabase(databaseUrl, driver), { provider: "pg", schema: { ...schema, apikey: pocApiKey } }),
    emailAndPassword: { enabled: true },
    ...(options.disabledPaths ? { disabledPaths: options.disabledPaths } : {}),
    plugins: [
      organization(),
      apiKey({ references: "organization", enableMetadata: true, defaultPrefix: "tr_poc_", maximumNameLength: 128, rateLimit: { enabled: false } }),
    ],
  });
}

type PocAuth = ReturnType<typeof createApiKeyPocAuth>;
type Metadata = { serviceAccountId?: unknown; environment?: unknown; allowedCidrs?: unknown; scopes?: unknown };

const strings = (value: unknown): string[] | null => Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;

/** Carries Trestle's service account, environment, CIDR, and scopes in plugin metadata. */
export class BetterAuthCredentialVerifier implements CredentialVerifier {
  readonly kind = "better_auth" as const;
  constructor(private readonly auth: PocAuth, private readonly operatorUserId: string) {}

  async issue(input: IssueCredential): Promise<IssuedSecret> {
    const created = await this.auth.api.createApiKey({ body: {
      organizationId: input.organizationId, userId: input.issuedBy, name: `service-account:${input.serviceAccountId}`,
      ...(input.expiresAt ? { expiresIn: Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 1000)) } : {}),
      metadata: { serviceAccountId: input.serviceAccountId, environment: input.environment, allowedCidrs: input.allowedCidrs, scopes: input.scopes },
    } });
    return { credentialId: created.id, token: created.key, displayPrefix: created.start ?? "tr_poc_" };
  }

  async verify(presented: string): Promise<VerifiedCredential | null> {
    const result = await this.auth.api.verifyApiKey({ body: { key: presented } });
    if (!result.valid || !result.key) return null;
    const metadata = (typeof result.key.metadata === "string" ? JSON.parse(result.key.metadata) : result.key.metadata ?? {}) as Metadata;
    const environment = metadata.environment === "local" || metadata.environment === "preview" || metadata.environment === "staging" || metadata.environment === "production" ? metadata.environment : null;
    return {
      credentialId: result.key.id,
      organizationId: result.key.referenceId,
      serviceAccountId: typeof metadata.serviceAccountId === "string" ? metadata.serviceAccountId : "",
      environment,
      scopes: strings(metadata.scopes) ?? [],
      expiresAt: result.key.expiresAt ? new Date(result.key.expiresAt) : null,
      revokedAt: result.key.enabled === false ? new Date() : null,
      allowedCidrs: strings(metadata.allowedCidrs),
    };
  }

  async revoke(credentialId: string): Promise<void> {
    await this.auth.api.updateApiKey({ body: { keyId: credentialId, userId: this.operatorUserId, enabled: false } });
  }
}
