import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";

import type { Database } from "./index.js";
import { parseNativeWebhookDestination } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { webhookEndpoint } from "./webhook-schema.js";
import { webhookSubscription } from "./webhook-schema.js";
import { webhookSecretVersion } from "./webhook-secret-schema.js";

export class WebhookSecretError extends Error {
  constructor(message: string) { super(message); this.name = "WebhookSecretError"; }
}

export type WebhookSecretAuthority = {
  authorize(input: { action: "read" | "manage" | "rotate"; organizationId: string; endpointId: string }): Promise<{ actorId: string; stepUpAt?: Date }>;
};

export type WebhookSecretMetadata = {
  id: string;
  version: number;
  fingerprint: string;
  state: "current" | "overlapping" | "revoked";
  activatedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

export type DisclosedWebhookSecret = { secret: string; metadata: WebhookSecretMetadata };
export type WebhookEndpointRegistration = {
  name: string;
  destinationUrl: string;
  provider: "local" | "native";
  subscriptions: readonly { type: string; version: number }[];
  availableEvents: readonly { type: string; version: number; entitlement?: string }[];
};

type WebhookSubscriptions = Pick<WebhookEndpointRegistration, "subscriptions" | "availableEvents">;

function validateSubscriptions(input: WebhookSubscriptions): void {
  if (!input.subscriptions.length || input.subscriptions.length > 100) throw new WebhookSecretError("Select 1–100 public webhook events");
  const allowed = new Set(input.availableEvents.map((event) => `${event.type}@${event.version}`));
  const requested = new Set<string>();
  for (const subscription of input.subscriptions) {
    const key = `${subscription.type}@${subscription.version}`;
    if (!allowed.has(key) || requested.has(key)) throw new WebhookSecretError("Webhook subscription is unavailable or duplicated");
    requested.add(key);
  }
}

const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array | ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

/** The same key material is supplied from encrypted Trestle runtime credentials. */
export async function createWebhookSecretCipher(masterKey: string, environment: "local" | "preview" | "staging" | "production") {
  if (encoder.encode(masterKey).length < 32) throw new WebhookSecretError("WEBHOOK_SECRET_KEY must contain at least 32 bytes");
  const base = await crypto.subtle.importKey("raw", encoder.encode(masterKey), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(`trestle.webhooks:${environment}:v1`), info: encoder.encode("endpoint-signing-secret") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return {
    async encrypt(secret: string, organizationId: string, endpointId: string, version: number): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const additionalData = encoder.encode(`${organizationId}\0${endpointId}\0${version}\0${environment}`);
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, encoder.encode(secret));
      return `v1:${base64(iv)}:${base64(ciphertext)}`;
    },
    async decrypt(value: string, organizationId: string, endpointId: string, version: number): Promise<string> {
      const [format, iv, ciphertext] = value.split(":");
      if (format !== "v1" || !iv || !ciphertext) throw new WebhookSecretError("Unsupported webhook secret ciphertext");
      try {
        const additionalData = encoder.encode(`${organizationId}\0${endpointId}\0${version}\0${environment}`);
        const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv), additionalData }, key, fromBase64(ciphertext));
        return new TextDecoder().decode(plaintext);
      } catch {
        throw new WebhookSecretError("Webhook secret could not be decrypted");
      }
    },
  };
}

/** Internal dispatcher boundary: use the current key for new signatures.
 * Overlapping keys remain available only for verification of older requests. */
export async function loadCurrentWebhookSigningSecret(input: {
  tenantDatabase: (organizationId: string) => Database;
  masterKey: string;
  environment: "local" | "preview" | "staging" | "production";
  organizationId: string;
  endpointId: string;
}): Promise<string | null> {
  const [row] = await input.tenantDatabase(input.organizationId).select({
    ciphertext: webhookSecretVersion.ciphertext,
    version: webhookSecretVersion.version,
  }).from(webhookSecretVersion).where(and(
    eq(webhookSecretVersion.organizationId, input.organizationId),
    eq(webhookSecretVersion.endpointId, input.endpointId),
    eq(webhookSecretVersion.state, "current"),
  )).limit(1);
  if (!row) return null;
  if (!row.ciphertext) throw new WebhookSecretError("Current webhook signing secret is missing ciphertext");
  const cipher = await createWebhookSecretCipher(input.masterKey, input.environment);
  return cipher.decrypt(row.ciphertext, input.organizationId, input.endpointId, row.version);
}

function nowFrom(clock: { now(): Date }): Date {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new WebhookSecretError("Invalid webhook secret clock");
  return value;
}

function requireActor(actorId: string): string {
  if (typeof actorId !== "string" || !actorId.trim()) throw new WebhookSecretError("Webhook secret actor is required");
  return actorId;
}

function requireRecentStepUp(stepUpAt: Date | undefined, now: Date): void {
  const age = stepUpAt instanceof Date ? now.getTime() - stepUpAt.getTime() : NaN;
  if (!Number.isFinite(age) || age < -30_000 || age > 5 * 60_000) throw new WebhookSecretError("Recent step-up authentication is required");
}

type SafeRow = Pick<typeof webhookSecretVersion.$inferSelect, "id" | "version" | "fingerprint" | "state" | "activatedAt" | "expiresAt" | "revokedAt">;

function metadata(row: SafeRow): WebhookSecretMetadata {
  return { id: row.id, version: row.version, fingerprint: row.fingerprint, state: row.state as WebhookSecretMetadata["state"], activatedAt: row.activatedAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt };
}

async function freshSecret(): Promise<{ value: string; fingerprint: string }> {
  const value = `whsec_${base64(crypto.getRandomValues(new Uint8Array(24)))}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return { value, fingerprint: Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("") };
}

/** Customer-facing methods return metadata; plaintext is disclosed only by issue/rotate. */
export class WebhookSecretService {
  private readonly cipher: ReturnType<typeof createWebhookSecretCipher>;

  constructor(private readonly input: {
    tenantDatabase: (organizationId: string) => Database;
    authority: WebhookSecretAuthority;
    masterKey: string;
    environment: "local" | "preview" | "staging" | "production";
    clock: { now(): Date };
  }) {
    if (typeof input.masterKey !== "string" || encoder.encode(input.masterKey).length < 32) throw new WebhookSecretError("WEBHOOK_SECRET_KEY must contain at least 32 bytes");
    this.cipher = createWebhookSecretCipher(input.masterKey, input.environment);
  }

  private async authorize(action: "read" | "manage" | "rotate", organizationId: string, endpointId: string, now: Date): Promise<string> {
    const grant = await this.input.authority.authorize({ action, organizationId, endpointId });
    const actorId = requireActor(grant.actorId);
    if (action === "rotate") requireRecentStepUp(grant.stepUpAt, now);
    return actorId;
  }

  /** Register the inert endpoint, subscriptions, and encrypted signing key in one tenant transaction. */
  async registerEndpoint(organizationId: string, input: WebhookEndpointRegistration): Promise<{ endpointId: string; secret: string; metadata: WebhookSecretMetadata }> {
    const now = nowFrom(this.input.clock);
    const endpointId = crypto.randomUUID();
    const actorId = await this.authorize("manage", organizationId, endpointId, now);
    const name = input.name.trim();
    if (!name || name.length > 120) throw new WebhookSecretError("Webhook endpoint name must be 1–120 characters");
    if (input.provider !== "local" && input.provider !== "native") throw new WebhookSecretError("Unsupported webhook endpoint provider");
    const destinationUrl = parseNativeWebhookDestination(input.destinationUrl).url;
    validateSubscriptions(input);
    const secret = await freshSecret();
    const cipher = await this.cipher;
    return this.input.tenantDatabase(organizationId).transaction(async (transaction) => {
      await transaction.insert(webhookEndpoint).values({
        id: endpointId, organizationId, environment: this.input.environment, name, destinationUrl,
        state: "disabled", provider: input.provider, createdBy: actorId, updatedBy: actorId,
        createdAt: now, updatedAt: now,
      });
      await transaction.insert(webhookSubscription).values(input.subscriptions.map((subscription) => ({
        organizationId, endpointId, publicEventType: subscription.type,
        publicVersion: subscription.version, createdBy: actorId, createdAt: now,
      })));
      const [row] = await transaction.insert(webhookSecretVersion).values({
        organizationId, endpointId, version: 1,
        ciphertext: await cipher.encrypt(secret.value, organizationId, endpointId, 1),
        fingerprint: secret.fingerprint, state: "current", activatedAt: now, createdBy: actorId,
      }).returning();
      if (!row) throw new WebhookSecretError("Webhook signing secret could not be created");
      return { endpointId, secret: secret.value, metadata: metadata(row) };
    });
  }

  async issue(organizationId: string, endpointId: string): Promise<DisclosedWebhookSecret> {
    const now = nowFrom(this.input.clock);
    const actorId = await this.authorize("manage", organizationId, endpointId, now);
    const secret = await freshSecret();
    const cipher = await this.cipher;
    return this.input.tenantDatabase(organizationId).transaction(async (transaction) => {
      const [endpoint] = await transaction.select({ id: webhookEndpoint.id }).from(webhookEndpoint).where(and(eq(webhookEndpoint.id, endpointId), eq(webhookEndpoint.organizationId, organizationId))).for("update").limit(1);
      if (!endpoint) throw new WebhookSecretError("Webhook endpoint was not found");
      const existing = await transaction.select({ id: webhookSecretVersion.id }).from(webhookSecretVersion).where(and(eq(webhookSecretVersion.endpointId, endpointId), eq(webhookSecretVersion.organizationId, organizationId))).limit(1);
      if (existing.length) throw new WebhookSecretError("Webhook endpoint already has a signing secret");
      const [row] = await transaction.insert(webhookSecretVersion).values({ organizationId, endpointId, version: 1, ciphertext: await cipher.encrypt(secret.value, organizationId, endpointId, 1), fingerprint: secret.fingerprint, state: "current", activatedAt: now, createdBy: actorId }).returning();
      if (!row) throw new WebhookSecretError("Webhook signing secret could not be created");
      return { secret: secret.value, metadata: metadata(row) };
    });
  }

  async rotate(organizationId: string, endpointId: string, overlapHours = 24): Promise<DisclosedWebhookSecret> {
    const now = nowFrom(this.input.clock);
    const actorId = await this.authorize("rotate", organizationId, endpointId, now);
    if (!Number.isInteger(overlapHours) || overlapHours < 0 || overlapHours > 7 * 24) throw new WebhookSecretError("Rotation overlap must be between 0 and 168 hours");
    const secret = await freshSecret();
    const cipher = await this.cipher;
    return this.input.tenantDatabase(organizationId).transaction(async (transaction) => {
      const [endpoint] = await transaction.select({ id: webhookEndpoint.id }).from(webhookEndpoint).where(and(eq(webhookEndpoint.id, endpointId), eq(webhookEndpoint.organizationId, organizationId))).for("update").limit(1);
      if (!endpoint) throw new WebhookSecretError("Webhook endpoint was not found");
      const rows = await transaction.select().from(webhookSecretVersion).where(and(eq(webhookSecretVersion.endpointId, endpointId), eq(webhookSecretVersion.organizationId, organizationId))).orderBy(asc(webhookSecretVersion.version));
      const current = rows.find((row) => row.state === "current");
      if (!current) throw new WebhookSecretError("Webhook endpoint has no current signing secret");
      const nextVersion = Math.max(...rows.map((row) => row.version)) + 1;
      for (const row of rows.filter((item) => item.state === "overlapping")) {
        await transaction.update(webhookSecretVersion).set({ state: "revoked", ciphertext: null, expiresAt: now, revokedAt: now, auditReason: "superseded by rotation" }).where(eq(webhookSecretVersion.id, row.id));
      }
      await transaction.update(webhookSecretVersion).set(overlapHours === 0
        ? { state: "revoked", ciphertext: null, expiresAt: now, revokedAt: now, auditReason: "zero-overlap rotation" }
        : { state: "overlapping", expiresAt: new Date(now.getTime() + overlapHours * 60 * 60_000) }).where(eq(webhookSecretVersion.id, current.id));
      const [created] = await transaction.insert(webhookSecretVersion).values({ organizationId, endpointId, version: nextVersion, ciphertext: await cipher.encrypt(secret.value, organizationId, endpointId, nextVersion), fingerprint: secret.fingerprint, state: "current", activatedAt: now, createdBy: actorId }).returning();
      if (!created) throw new WebhookSecretError("Webhook signing secret could not be rotated");
      return { secret: secret.value, metadata: metadata(created) };
    });
  }

  async revokePrevious(organizationId: string, endpointId: string, version: number, reason: string): Promise<boolean> {
    const now = nowFrom(this.input.clock);
    await this.authorize("rotate", organizationId, endpointId, now);
    if (!Number.isInteger(version) || version < 1) throw new WebhookSecretError("Invalid webhook secret version");
    if (typeof reason !== "string" || reason.trim().length < 4) throw new WebhookSecretError("Immediate revocation requires an audit reason");
    return this.input.tenantDatabase(organizationId).transaction(async (transaction) => {
      const [endpoint] = await transaction.select({ id: webhookEndpoint.id }).from(webhookEndpoint).where(and(eq(webhookEndpoint.id, endpointId), eq(webhookEndpoint.organizationId, organizationId))).for("update").limit(1);
      if (!endpoint) return false;
      const [revoked] = await transaction.update(webhookSecretVersion).set({ state: "revoked", ciphertext: null, expiresAt: now, revokedAt: now, auditReason: reason.trim() }).where(and(eq(webhookSecretVersion.endpointId, endpointId), eq(webhookSecretVersion.organizationId, organizationId), eq(webhookSecretVersion.version, version), eq(webhookSecretVersion.state, "overlapping"))).returning();
      return Boolean(revoked);
    });
  }

  async list(organizationId: string, endpointId: string): Promise<WebhookSecretMetadata[]> {
    await this.authorize("read", organizationId, endpointId, nowFrom(this.input.clock));
    const rows = await this.input.tenantDatabase(organizationId).select({
      id: webhookSecretVersion.id, version: webhookSecretVersion.version, fingerprint: webhookSecretVersion.fingerprint,
      state: webhookSecretVersion.state, activatedAt: webhookSecretVersion.activatedAt,
      expiresAt: webhookSecretVersion.expiresAt, revokedAt: webhookSecretVersion.revokedAt,
    }).from(webhookSecretVersion).where(and(eq(webhookSecretVersion.endpointId, endpointId), eq(webhookSecretVersion.organizationId, organizationId))).orderBy(asc(webhookSecretVersion.version));
    return rows.map(metadata);
  }

  /** Safe scheduled cleanup: expired overlap material is permanently erased. */
  async eraseExpiredOverlaps(organizationId: string, endpointId: string): Promise<number> {
    const now = nowFrom(this.input.clock);
    const erased = await this.input.tenantDatabase(organizationId).update(webhookSecretVersion)
      .set({ state: "revoked", ciphertext: null, revokedAt: now, auditReason: "rotation overlap expired" })
      .where(and(eq(webhookSecretVersion.endpointId, endpointId), eq(webhookSecretVersion.organizationId, organizationId), eq(webhookSecretVersion.state, "overlapping"), lte(webhookSecretVersion.expiresAt, now))).returning();
    return erased.length;
  }

  /** Internal delivery capability only. Never return this value from a customer or admin route. */
  async activeForDelivery(organizationId: string, endpointId: string): Promise<string[]> {
    const now = nowFrom(this.input.clock);
    const rows = await this.input.tenantDatabase(organizationId).select().from(webhookSecretVersion).where(and(eq(webhookSecretVersion.endpointId, endpointId), eq(webhookSecretVersion.organizationId, organizationId), inArray(webhookSecretVersion.state, ["current", "overlapping"]))).orderBy(asc(webhookSecretVersion.version));
    const cipher = await this.cipher;
    const active = rows.filter((row) => row.state === "current" || (row.expiresAt && row.expiresAt.getTime() > now.getTime()));
    return Promise.all(active.map((row) => {
      if (!row.ciphertext) throw new WebhookSecretError("Active webhook secret is missing ciphertext");
      return cipher.decrypt(row.ciphertext, organizationId, endpointId, row.version);
    }));
  }
}

/** Disabling must remain possible even if the encryption key is unavailable. */
export async function setWebhookEndpointState(input: {
  organizationId: string;
  endpointId: string;
  environment: "local" | "preview" | "staging" | "production";
  state: "active" | "disabled";
  activeProvider?: "local" | "native";
  authority: WebhookSecretAuthority;
  tenantDatabase: (organizationId: string) => Database;
  clock: { now(): Date };
}): Promise<boolean> {
  const now = nowFrom(input.clock);
  const actorId = requireActor((await input.authority.authorize({ action: "manage", organizationId: input.organizationId, endpointId: input.endpointId })).actorId);
  return input.tenantDatabase(input.organizationId).transaction(async (transaction) => {
    const [endpoint] = await transaction.select({ id: webhookEndpoint.id, provider: webhookEndpoint.provider }).from(webhookEndpoint).where(and(
      eq(webhookEndpoint.id, input.endpointId), eq(webhookEndpoint.organizationId, input.organizationId),
      eq(webhookEndpoint.environment, input.environment), isNull(webhookEndpoint.deletedAt),
    )).for("update").limit(1);
    if (!endpoint) return false;
    if (input.state === "active") {
      if (!input.activeProvider || endpoint.provider !== input.activeProvider) throw new WebhookSecretError("Endpoint provider does not match the active delivery capability");
      const [subscription] = await transaction.select({ endpointId: webhookSubscription.endpointId }).from(webhookSubscription).where(and(
        eq(webhookSubscription.organizationId, input.organizationId), eq(webhookSubscription.endpointId, input.endpointId),
      )).limit(1);
      const [secret] = await transaction.select({ endpointId: webhookSecretVersion.endpointId }).from(webhookSecretVersion).where(and(
        eq(webhookSecretVersion.organizationId, input.organizationId), eq(webhookSecretVersion.endpointId, input.endpointId), eq(webhookSecretVersion.state, "current"),
      )).limit(1);
      if (!subscription || !secret) throw new WebhookSecretError("Endpoint needs a subscription and current signing secret before activation");
    }
    await transaction.update(webhookEndpoint).set({ state: input.state, updatedAt: now, updatedBy: actorId }).where(and(
      eq(webhookEndpoint.id, input.endpointId), eq(webhookEndpoint.organizationId, input.organizationId),
    ));
    return true;
  });
}

/** Replace the complete event selection atomically; active delivery sees either old or new subscriptions. */
export async function replaceWebhookSubscriptions(input: {
  organizationId: string;
  endpointId: string;
  environment: "local" | "preview" | "staging" | "production";
  authority: WebhookSecretAuthority;
  tenantDatabase: (organizationId: string) => Database;
  clock: { now(): Date };
} & WebhookSubscriptions): Promise<boolean> {
  validateSubscriptions(input);
  const now = nowFrom(input.clock);
  const actorId = requireActor((await input.authority.authorize({ action: "manage", organizationId: input.organizationId, endpointId: input.endpointId })).actorId);
  return input.tenantDatabase(input.organizationId).transaction(async (transaction) => {
    const [endpoint] = await transaction.select({ id: webhookEndpoint.id }).from(webhookEndpoint).where(and(
      eq(webhookEndpoint.id, input.endpointId), eq(webhookEndpoint.organizationId, input.organizationId),
      eq(webhookEndpoint.environment, input.environment), isNull(webhookEndpoint.deletedAt),
    )).for("update").limit(1);
    if (!endpoint) return false;
    const previous = await transaction.select({ type: webhookSubscription.publicEventType, version: webhookSubscription.publicVersion })
      .from(webhookSubscription).where(and(eq(webhookSubscription.organizationId, input.organizationId), eq(webhookSubscription.endpointId, input.endpointId)));
    const eventKey = (event: { type: string; version: number }) => `${event.type}@${event.version}`;
    if (previous.length === input.subscriptions.length && previous.every((event) => input.subscriptions.some((requested) => eventKey(requested) === eventKey(event)))) return true;
    await transaction.delete(webhookSubscription).where(and(eq(webhookSubscription.organizationId, input.organizationId), eq(webhookSubscription.endpointId, input.endpointId)));
    await transaction.insert(webhookSubscription).values(input.subscriptions.map((subscription) => ({
      organizationId: input.organizationId, endpointId: input.endpointId,
      publicEventType: subscription.type, publicVersion: subscription.version,
      createdBy: actorId, createdAt: now,
    })));
    await transaction.update(webhookEndpoint).set({ updatedAt: now, updatedBy: actorId }).where(and(
      eq(webhookEndpoint.id, input.endpointId), eq(webhookEndpoint.organizationId, input.organizationId),
    ));
    return true;
  });
}
