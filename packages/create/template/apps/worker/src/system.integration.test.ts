import { createAuth } from "@__TRESTLE_PROJECT_NAME__/auth";
import { PostgresBillingProjectionRepository } from "@__TRESTLE_PROJECT_NAME__/billing";
import { activeApplicationRoles, grantApplicationRoles, replaceApplicationRoles, artifactMetadata, createDatabase, createSignedWebhookHeaders, createTenantDatabase, eventInbox, hasArtifactStorageKey, organization, organizationEntitlement, organizationSubscription, outboxMessage, PostgresArtifactMetadataRepository, PostgresOutboxStore, user, webhookAttempt, webhookDelivery, webhookEndpoint, webhookMessage, webhookSecretVersion, webhookSubscription } from "@__TRESTLE_PROJECT_NAME__/db";
import type { EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";
import { clearCapturedEmails, listCapturedEmails } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { NonRetryableError } from "cloudflare:workflows";
import { TrestleWorkflow } from "./cloudflare-workflow.js";
import { runArtifactReferenceAudit } from "./artifact-reference-audit.js";
import { runArtifactOrphanAudit } from "./artifact-orphan-audit.js";
import { projectWebhookForEvent } from "./webhook-runtime.js";
import worker, { app, eventConsumers } from "./index.js";

const databaseUrl = process.env.TRESTLE_SYSTEM_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("local product path", () => {
  it("verifies email, signs in, selects an organization, and reads tenant billing", async () => {
    const unique = crypto.randomUUID();
    const email = `system-${unique}@example.test`;
    const slug = `system-${unique}`;
    const environment = {
      DATABASE_URL: databaseUrl!,
      DATABASE_DRIVER: "postgres-js" as const,
      BETTER_AUTH_SECRET: "system-test-secret-with-at-least-thirty-two-characters",
      BETTER_AUTH_URL: "http://localhost:8787",
      WEB_ORIGIN: "http://localhost:42069",
      APP_ENV: "local" as const,
      EMAIL_DELIVERY_MODE: "local" as const,
      STRIPE_MODE: "local" as const,
    };
    const database = createDatabase(process.env.TRESTLE_SYSTEM_TEST_MIGRATION_URL ?? databaseUrl!, "postgres-js");
    const billingRepository = new PostgresBillingProjectionRepository(databaseUrl!, "postgres-js");
    let organizationId: string | undefined;
    let secondOrganizationId: string | undefined;
    let joinerId: string | undefined;
    let articleId: string | undefined;
    let secondArticleId: string | undefined;
    let webhookEndpointId: string | undefined;
    let artifactId: string | undefined;
    let r2ArtifactId: string | undefined;
    clearCapturedEmails();
    try {
      const signUp = await app.request("http://localhost:8787/api/auth/sign-up/email", {
        method: "POST", headers: { "content-type": "application/json", origin: environment.WEB_ORIGIN },
        body: JSON.stringify({ name: "System Test", email, password: "system-test-password-123" }),
      }, environment);
      expect(signUp.status).toBe(200);
      const captured = listCapturedEmails().find((message) => message.to.includes(email));
      expect(captured?.subject).toBe("Verify your email");
      const verificationLink = captured?.text.match(/https?:\/\/\S+/u)?.[0];
      expect(verificationLink).toBeTruthy();
      const verify = await app.request(verificationLink!, { method: "GET" }, environment);
      expect([200, 302]).toContain(verify.status);

      const signIn = await app.request("http://localhost:8787/api/auth/sign-in/email", {
        method: "POST", headers: { "content-type": "application/json", origin: environment.WEB_ORIGIN },
        body: JSON.stringify({ email, password: "system-test-password-123" }),
      }, environment);
      expect(signIn.status).toBe(200);
      const cookie = signIn.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();

      const create = await app.request("http://localhost:8787/api/auth/organization/create", {
        method: "POST", headers: { "content-type": "application/json", origin: environment.WEB_ORIGIN, cookie: cookie! },
        body: JSON.stringify({ name: "System Test Organization", slug }),
      }, environment);
      expect(create.status).toBe(200);
      const created = await create.json() as { id: string };
      organizationId = created.id;
      expect(organizationId).toBeTruthy();

      // The creator is the organization Owner and, by explicit bootstrap policy, its application administrator.
      const creatorAccess = await app.request("http://localhost:8787/api/tenant/access", { headers: { origin: environment.WEB_ORIGIN, cookie: cookie!, "x-trestle-tenant": organizationId! } }, environment);
      expect(creatorAccess.status).toBe(200);
      await expect(creatorAccess.json()).resolves.toMatchObject({ organizationId, assignments: { organization: ["owner"], application: ["app_admin"] } });
      // Members added later start with no application role, whatever their organization role.
      joinerId = `system-joiner-${crypto.randomUUID()}`;
      await database.insert(user).values({ id: joinerId, name: "Joiner", email: `${joinerId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
      await createAuth(environment).api.addMember({ body: { userId: joinerId, organizationId: organizationId!, role: "admin" } });
      const tenantRoles = createTenantDatabase(databaseUrl!, "postgres-js", organizationId!);
      expect(await activeApplicationRoles(tenantRoles, organizationId!, joinerId)).toEqual([]);
      const [creator] = await database.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
      expect(await activeApplicationRoles(tenantRoles, organizationId!, creator!.id)).toEqual(["app_admin"]);

      // Organization ownership alone never reaches product resources such as artifacts.
      await replaceApplicationRoles(tenantRoles, { organizationId: organizationId!, userId: creator!.id, roles: [], actor: "test", now: new Date() });
      const ownerOnlyUpload = await app.request("http://localhost:8787/api/artifacts", { method: "POST", headers: { origin: environment.WEB_ORIGIN, cookie: cookie!, "x-trestle-tenant": organizationId!, "content-type": "text/plain" }, body: "owner only" }, environment);
      expect(ownerOnlyUpload.status).toBe(403);
      await grantApplicationRoles(tenantRoles, { organizationId: organizationId!, userId: creator!.id, roles: ["app_admin"], grantedBy: "test" });

      await billingRepository.put({ organizationId: organizationId!, provider: "local", plan: "starter", planVersion: 1, status: "active", cancelAtPeriodEnd: false, entitlements: ["article.basic"] });

      const billing = await app.request("http://localhost:8787/api/billing/subscription", {
        headers: { origin: environment.WEB_ORIGIN, cookie: cookie!, "x-trestle-tenant": organizationId! },
      }, environment);
      expect(billing.status).toBe(200);
      await expect(billing.json()).resolves.toMatchObject({ subscription: { organizationId, plan: "starter" } });
      const artifactHeaders = { origin: environment.WEB_ORIGIN, cookie: cookie!, "x-trestle-tenant": organizationId! };
      const upload = await app.request("http://localhost:8787/api/artifacts", {
        method: "POST", headers: { ...artifactHeaders, "content-type": "text/plain" }, body: "private artifact",
      }, environment);
      expect(upload.status).toBe(201);
      artifactId = (await upload.json() as { artifact: { id: string } }).artifact.id;
      // Pages forwards API requests under the app hostname, while signed
      // downloads must resolve to the Worker's direct artifact route.
      const access = await app.request(`http://localhost:42069/api/artifacts/${artifactId}/access`, { headers: artifactHeaders }, environment);
      expect(access.status).toBe(200);
      const signedUrl = (await access.json() as { url: string }).url;
      expect(new URL(signedUrl).origin).toBe(environment.BETTER_AUTH_URL);
      const downloaded = await app.request(signedUrl, undefined, environment);
      expect(downloaded.status).toBe(200);
      expect(await downloaded.text()).toBe("private artifact");
      expect(downloaded.headers.get("content-disposition")).toContain("attachment");
      const forged = new URL(signedUrl);
      forged.searchParams.set("organization", crypto.randomUUID());
      expect((await app.request(forged.toString(), undefined, environment)).status).toBe(404);
      expect((await app.request(`http://localhost:8787/api/artifacts/${artifactId}/access`, {
        headers: { ...artifactHeaders, "x-trestle-tenant": crypto.randomUUID() },
      }, environment)).status).toBe(404);
      expect((await app.request(`http://localhost:8787/api/artifacts/${artifactId}`, { method: "DELETE", headers: artifactHeaders }, environment)).status).toBe(204);
      artifactId = undefined;
      expect((await app.request(signedUrl, undefined, environment)).status).toBe(404);
      const r2Objects = new Map<string, Uint8Array>();
      const r2Environment = { ...environment, TRESTLE_ARTIFACTS: {
        put: async (key: string, body: Uint8Array) => { r2Objects.set(key, body.slice()); },
        get: async (key: string) => { const body = r2Objects.get(key); return body ? { size: body.byteLength, arrayBuffer: async () => body.slice().buffer } : null; },
        head: async (key: string) => { const body = r2Objects.get(key); if (!body) return null; const [owner, artifactId] = key.split("/"); return { size: body.byteLength, httpMetadata: { contentType: "text/plain" }, customMetadata: { organizationId: owner!, artifactId: artifactId! } }; },
        delete: async (key: string) => { r2Objects.delete(key); },
      } };
      const r2Upload = await app.request("http://localhost:8787/api/artifacts", {
        method: "POST", headers: { ...artifactHeaders, "content-type": "text/plain" }, body: "durable artifact",
      }, r2Environment);
      expect(r2Upload.status).toBe(201);
      r2ArtifactId = (await r2Upload.json() as { artifact: { id: string } }).artifact.id;
      const [persistedArtifact] = await database.select().from(artifactMetadata).where(eq(artifactMetadata.id, r2ArtifactId)).limit(1);
      if (!persistedArtifact) throw new Error("R2 artifact metadata was not persisted");
      expect(persistedArtifact).toMatchObject({ organizationId, contentType: "text/plain" });
      expect(persistedArtifact.storageKey).toMatch(new RegExp(`^${organizationId}/${r2ArtifactId}/[0-9a-f-]{36}/${r2ArtifactId}$`));
      expect(r2Objects.has(persistedArtifact.storageKey)).toBe(true);
      const findings: unknown[] = [];
      expect(await runArtifactReferenceAudit(
        [{ id: r2ArtifactId, organizationId: organizationId! }],
        (tenantId, id) => new PostgresArtifactMetadataRepository(createTenantDatabase(databaseUrl!, "postgres-js", tenantId)).get(tenantId, id),
        (key) => r2Environment.TRESTLE_ARTIFACTS.head(key),
        (item) => findings.push(item),
      )).toEqual({ selected: 1, checked: 1, skipped: 0, missing: 0, mismatched: 0, failed: 0 });
      expect(findings).toEqual([]);
      const orphanKey = `${organizationId}/unreferenced/private-object`;
      r2Objects.set(orphanKey, new TextEncoder().encode("unreferenced"));
      const orphanFindings: unknown[] = [];
      const orphanResult = await runArtifactOrphanAudit(organizationId!, [
        { key: persistedArtifact.storageKey, size: 16, uploaded: new Date("2026-01-01T00:00:00Z") },
        { key: orphanKey, size: 12, uploaded: new Date("2026-01-01T00:00:00Z") },
      ], (tenantId, key) => hasArtifactStorageKey(createTenantDatabase(databaseUrl!, "postgres-js", tenantId, { readOnly: true }), tenantId, key),
      (key) => r2Environment.TRESTLE_ARTIFACTS.head(key), (item) => orphanFindings.push(item), new Date("2026-09-23T12:00:00Z"));
      expect(orphanResult).toEqual({ listed: 2, checked: 2, skipped: 0, orphaned: 1, failed: 0 });
      expect(orphanFindings).toMatchObject([{ organizationId, reason: "orphan" }]);
      expect(JSON.stringify(orphanFindings)).not.toContain(orphanKey);
      r2Objects.delete(orphanKey);
      const r2Access = await app.request(`http://localhost:8787/api/artifacts/${r2ArtifactId}/access`, { headers: artifactHeaders }, r2Environment);
      expect(r2Access.status).toBe(200);
      const r2Url = (await r2Access.json() as { url: string }).url;
      expect(await (await app.request(r2Url, undefined, r2Environment)).text()).toBe("durable artifact");
      expect((await app.request(`http://localhost:8787/api/artifacts/${r2ArtifactId}/access`, {
        headers: { ...artifactHeaders, "x-trestle-tenant": crypto.randomUUID() },
      }, r2Environment)).status).toBe(404);
      expect((await app.request(`http://localhost:8787/api/artifacts/${r2ArtifactId}`, { method: "DELETE", headers: artifactHeaders }, r2Environment)).status).toBe(204);
      expect(r2Objects.size).toBe(0);
      const [deletedArtifact] = await database.select().from(artifactMetadata).where(eq(artifactMetadata.id, r2ArtifactId)).limit(1);
      expect(deletedArtifact?.deletedAt).toBeInstanceOf(Date);
      expect((await app.request(r2Url, undefined, r2Environment)).status).toBe(404);
      if (process.env.TRESTLE_SYSTEM_TEST_ARTICLES === "1") {
        const headers = { origin: environment.WEB_ORIGIN, cookie: cookie!, "x-trestle-tenant": organizationId!, "content-type": "application/json" };
        const localWebhookEnabled = process.env.TRESTLE_SYSTEM_TEST_WEBHOOKS === "1";
        const webhookEnvironment = { ...environment, WEBHOOK_DELIVERY_MODE: "local" as const, WEBHOOK_SECRET_KEY: "system-test-webhook-key-with-at-least-32-bytes" };
        let webhookSecret: string | undefined;
        if (localWebhookEnabled) {
          const catalogResponse = await app.request("http://localhost:8787/api/developer/webhooks/events", { headers }, webhookEnvironment);
          expect(catalogResponse.status).toBe(200);
          const catalogEvents = (await catalogResponse.json() as { events: Array<{ type: string; version: number }> }).events
            .filter((event) => event.type.startsWith("resource.article."))
            .map((event) => `${event.type}@${event.version}`).sort();
          expect(catalogEvents).toEqual(["resource.article.created@1", "resource.article.updated@1"]);
          const registered = await app.request("http://localhost:8787/api/developer/webhooks/endpoints", {
            method: "POST", headers, body: JSON.stringify({ name: "System test local receiver", destinationUrl: "https://example.com/hooks", subscriptions: [
              { type: "resource.article.created", version: 1 }, { type: "resource.article.updated", version: 1 },
            ] }),
          }, webhookEnvironment);
          expect(registered.status).toBe(201);
          const registration = await registered.json() as { endpoint: { id: string }; signingSecret: string };
          webhookEndpointId = registration.endpoint.id;
          webhookSecret = registration.signingSecret;
          expect(webhookSecret).toMatch(/^whsec_/u);
          const activated = await app.request(`http://localhost:8787/api/developer/webhooks/endpoints/${webhookEndpointId}/state`, {
            method: "PATCH", headers, body: JSON.stringify({ state: "active" }),
          }, webhookEnvironment);
          expect(activated.status).toBe(200);
        }
        const createdArticle = await app.request("http://localhost:8787/api/articles", {
          method: "POST", headers, body: JSON.stringify({ name: "System Article", summary: "Draft", published: false }),
        }, environment);
        expect(createdArticle.status).toBe(201);
        const { article } = await createdArticle.json() as { article: { id: string } };
        articleId = article.id;
        const [outbox] = await database.select().from(outboxMessage).where(eq(outboxMessage.resourceId, article.id)).limit(1);
        expect(outbox).toMatchObject({ eventName: "resource.article.created", resourceType: "article", resourceId: article.id, organizationId, status: "pending", payload: { resourceId: article.id } });
        expect(outbox?.correlationId).toBeTruthy();
        const queued: unknown[] = [];
        // Other integration scenarios can leave earlier committed outbox rows.
        // A scheduled run leases only one bounded batch, so keep dispatching
        // until this event is reached rather than assuming it is in batch one.
        for (let batch = 0; batch < 100 && !queued.some((event) => (event as { id?: string }).id === outbox!.id); batch++) {
          await worker.scheduled(undefined, {
            ...environment,
            TRESTLE_EVENTS: { send: async (body: unknown) => { queued.push(body); } },
          });
        }
        const queuedEvent = queued.find((event) => (event as { id?: string }).id === outbox!.id);
        expect(queuedEvent).toMatchObject({ id: outbox!.id, name: "resource.article.created", resource: { type: "article", id: article.id } });
        expect(queuedEvent).not.toHaveProperty("organizationId");
        expect(queuedEvent).not.toHaveProperty("payload.organizationId");
        const workflowInstances = new Map<string, EventEnvelope>();
        const workflowEnvironment = { ...environment, TRESTLE_WORKFLOWS_ENABLED: "true", TRESTLE_WORKFLOW: {
          create: async ({ id, params }: { id: string; params: EventEnvelope }) => { if (workflowInstances.has(id)) throw new Error("duplicate instance"); workflowInstances.set(id, params); return { id }; },
          get: async (id: string) => { if (!workflowInstances.has(id)) throw new Error("not found"); return { id }; },
        } };
        const delivery: string[] = [];
        expect(await worker.queue({ messages: [{ body: queuedEvent, ack: () => delivery.push("ack"), retry: () => delivery.push("retry") }] }, workflowEnvironment)).toEqual({ acknowledged: 1, retried: 0 });
        expect(delivery).toEqual(["ack"]);
        expect(workflowInstances.get(outbox!.id)).toMatchObject({ id: outbox!.id, idempotencyKey: outbox!.idempotencyKey });
        const workflow = Object.assign(new TrestleWorkflow(), { env: localWebhookEnabled ? webhookEnvironment : environment });
        const workflowEvent = { payload: workflowInstances.get(outbox!.id)!, instanceId: outbox!.id, timestamp: new Date(), workflowName: "test-workflow" };
        const stepNames: string[] = [];
        const stepConfigs: unknown[] = [];
        const step = { do: async (name: string, config: unknown, callback: () => Promise<void>) => { stepNames.push(name); stepConfigs.push(config); await callback(); } } as Parameters<TrestleWorkflow["run"]>[1];
        await workflow.run(workflowEvent, step);
        await workflow.run(workflowEvent, step);
        expect(stepNames).toEqual(["consume-event-v1", "consume-event-v1"]);
        expect(stepConfigs[0]).toMatchObject({ retries: { limit: 5, backoff: "exponential" }, timeout: "2 minutes" });
        if (localWebhookEnabled) {
          const [message] = await database.select().from(webhookMessage).where(eq(webhookMessage.sourceEventId, outbox!.id));
          expect(message).toMatchObject({ organizationId, publicEventType: "resource.article.created", publicVersion: 1, resourceId: article.id, status: "ready" });
          expect(message?.envelope).toMatchObject({ data: { resourceId: article.id } });
          const [delivery] = await database.select().from(webhookDelivery).where(eq(webhookDelivery.messageId, message!.id));
          expect(delivery).toMatchObject({ endpointId: webhookEndpointId, organizationId, state: "succeeded", attemptCount: 1 });
          const [attempt] = await database.select().from(webhookAttempt).where(eq(webhookAttempt.deliveryId, delivery!.id));
          expect(attempt).toMatchObject({ kind: "local", outcome: "succeeded", attemptNumber: 1, requestUrl: "https://example.com/hooks" });
          expect(attempt?.requestBody).toContain(article.id);
          expect(attempt?.requestBody).not.toContain("System Article");
          expect(attempt?.requestHeaders).toMatchObject(await createSignedWebhookHeaders({
            secret: webhookSecret!, messageId: message!.id, body: attempt!.requestBody!, now: attempt!.attemptedAt,
          }));
          const inspection = await app.request(`http://localhost:8787/api/developer/webhooks/endpoints/${webhookEndpointId}/deliveries`, { headers }, webhookEnvironment);
          expect(inspection.status).toBe(200);
          const inspectionBody = await inspection.text();
          expect(inspectionBody).toContain(delivery!.id);
          expect(inspectionBody).not.toContain(webhookSecret);
          expect(inspectionBody).not.toContain("example.com/hooks");
        }
        const duplicateDelivery: string[] = [];
        expect(await worker.queue({ messages: [{ body: queuedEvent, ack: () => duplicateDelivery.push("ack"), retry: () => duplicateDelivery.push("retry") }] }, workflowEnvironment)).toEqual({ acknowledged: 1, retried: 0 });
        expect(duplicateDelivery).toEqual(["ack"]);
        const [inbox] = await database.select().from(eventInbox).where(eq(eventInbox.idempotencyKey, outbox!.idempotencyKey)).limit(1);
        expect(inbox).toMatchObject({ status: "completed", attempts: 1 });
        const retryKey = `system.workflow.retry:${article.id}`;
        const retryEnvelope: EventEnvelope = {
          id: crypto.randomUUID(), name: "system.workflow.retry", schemaVersion: 1,
          occurredAt: new Date().toISOString(), resource: { type: "workflow_test", id: crypto.randomUUID() },
          correlationId: crypto.randomUUID(), idempotencyKey: retryKey,
          payload: { resourceId: article.id },
        };
        let handlerAttempts = 0;
        eventConsumers.register({
          name: retryEnvelope.name, schemaVersion: 1,
          parse: (payload: unknown) => {
            if (!payload || typeof payload !== "object" || (payload as { resourceId?: unknown }).resourceId !== article.id) throw new Error("Invalid workflow retry payload");
            return payload;
          },
        }, async () => { if (++handlerAttempts === 1) throw new Error("Transient workflow handler failure"); });
        const retryStore = new PostgresOutboxStore(databaseUrl!, { assumeApplicationRole: true });
        try { await retryStore.append(retryEnvelope, { organizationId: organizationId! }); }
        finally { await retryStore.close(); }
        const retryWorkflow = Object.assign(new TrestleWorkflow(), { env: environment });
        const retryEvent = { payload: retryEnvelope, instanceId: retryEnvelope.id, timestamp: new Date(), workflowName: "retry-test-workflow" };
        await expect(retryWorkflow.run(retryEvent, step)).rejects.toThrow("Workflow handler failed");
        const [released] = await database.select().from(eventInbox).where(eq(eventInbox.idempotencyKey, retryKey)).limit(1);
        expect(released).toMatchObject({ status: "processing", attempts: 1, lastError: "Error" });
        await retryWorkflow.run(retryEvent, step);
        await retryWorkflow.run(retryEvent, step);
        const [completedRetry] = await database.select().from(eventInbox).where(eq(eventInbox.idempotencyKey, retryKey)).limit(1);
        expect(completedRetry).toMatchObject({ status: "completed", attempts: 2, lastError: null });
        expect(handlerAttempts).toBe(2);
        // A forged Queue message that reuses the committed ID and idempotency key
        // but carries a different payload never reaches the registered handler,
        // is never masked as an inbox duplicate, and never creates a Workflow.
        const forgedRetry = { ...retryEnvelope, payload: { resourceId: article.id, forged: true } };
        const forgedDelivery: string[] = [];
        expect(await worker.queue({ messages: [{ body: forgedRetry, ack: () => forgedDelivery.push("ack"), retry: () => forgedDelivery.push("retry") }] }, environment)).toEqual({ acknowledged: 0, retried: 1 });
        expect(await worker.queue({ messages: [{ body: forgedRetry, ack: () => forgedDelivery.push("ack"), retry: () => forgedDelivery.push("retry") }] }, workflowEnvironment)).toEqual({ acknowledged: 0, retried: 1 });
        expect(forgedDelivery).toEqual(["retry", "retry"]);
        expect(workflowInstances.has(retryEnvelope.id)).toBe(false);
        await expect(retryWorkflow.run({ ...retryEvent, payload: forgedRetry }, step)).rejects.toBeInstanceOf(NonRetryableError);
        expect(handlerAttempts).toBe(2);
        const invalidDelivery: string[] = [];
        expect(await worker.queue({ messages: [{ body: { ...(queuedEvent as object), payload: { resourceId: 42 } }, ack: () => invalidDelivery.push("ack"), retry: () => invalidDelivery.push("retry") }] }, workflowEnvironment)).toEqual({ acknowledged: 0, retried: 1 });
        expect(invalidDelivery).toEqual(["retry"]);
        const [dispatched] = await database.select().from(outboxMessage).where(eq(outboxMessage.id, outbox!.id)).limit(1);
        expect(dispatched?.status).toBe("succeeded");
        const second = await app.request("http://localhost:8787/api/auth/organization/create", {
          method: "POST", headers: { "content-type": "application/json", origin: environment.WEB_ORIGIN, cookie: cookie! },
          body: JSON.stringify({ name: "Second System Organization", slug: `second-${slug}` }),
        }, environment);
        expect(second.status).toBe(200);
        secondOrganizationId = (await second.json() as { id: string }).id;
        await billingRepository.put({ organizationId: secondOrganizationId!, provider: "local", plan: "pro", planVersion: 1, status: "active", cancelAtPeriodEnd: false, entitlements: ["article.basic", "workflows.advanced"] });
        const secondHeaders = { ...headers, "x-trestle-tenant": secondOrganizationId };
        const secondBilling = await app.request("http://localhost:8787/api/billing/subscription", { headers: secondHeaders }, environment);
        await expect(secondBilling.json()).resolves.toMatchObject({ subscription: { organizationId: secondOrganizationId, plan: "pro" } });
        const secondList = await app.request("http://localhost:8787/api/articles", { headers: secondHeaders }, environment);
        expect(secondList.status).toBe(200);
        expect((await secondList.json() as { articles: Array<{ id: string }> }).articles).toHaveLength(0);
        expect((await app.request(`http://localhost:8787/api/articles/${article.id}`, { headers: secondHeaders }, environment)).status).toBe(404);
        expect((await app.request(`http://localhost:8787/api/articles/${article.id}`, {
          method: "PATCH", headers: secondHeaders, body: JSON.stringify({ summary: "Cross-tenant edit" }),
        }, environment)).status).toBe(404);
        expect((await app.request(`http://localhost:8787/api/articles/${article.id}`, { method: "DELETE", headers: secondHeaders }, environment)).status).toBe(404);
        const createdSecondArticle = await app.request("http://localhost:8787/api/articles", {
          method: "POST", headers: secondHeaders, body: JSON.stringify({ name: "Second Tenant Article", summary: "Private", published: false }),
        }, environment);
        expect(createdSecondArticle.status).toBe(201);
        secondArticleId = (await createdSecondArticle.json() as { article: { id: string } }).article.id;
        expect((await app.request(`http://localhost:8787/api/articles/${secondArticleId}`, { headers }, environment)).status).toBe(404);
        const setActive = async (selected: string) => await app.request("http://localhost:8787/api/auth/organization/set-active", {
          method: "POST", headers: { "content-type": "application/json", origin: environment.WEB_ORIGIN, cookie: cookie! },
          body: JSON.stringify({ organizationId: selected }),
        }, environment);
        expect((await setActive(secondOrganizationId)).status).toBe(200);
        const activeSecondBilling = await app.request("http://localhost:8787/api/billing/subscription", { headers: { origin: environment.WEB_ORIGIN, cookie: cookie! } }, environment);
        await expect(activeSecondBilling.json()).resolves.toMatchObject({ subscription: { organizationId: secondOrganizationId, plan: "pro" } });
        const activeSecond = await app.request("http://localhost:8787/api/articles", { headers: { origin: environment.WEB_ORIGIN, cookie: cookie! } }, environment);
        expect((await activeSecond.json() as { articles: Array<{ id: string }> }).articles.map((item) => item.id)).toEqual([secondArticleId]);
        expect((await setActive(organizationId!)).status).toBe(200);
        const activeFirstBilling = await app.request("http://localhost:8787/api/billing/subscription", { headers: { origin: environment.WEB_ORIGIN, cookie: cookie! } }, environment);
        await expect(activeFirstBilling.json()).resolves.toMatchObject({ subscription: { organizationId, plan: "starter" } });
        const activeFirst = await app.request("http://localhost:8787/api/articles", { headers: { origin: environment.WEB_ORIGIN, cookie: cookie! } }, environment);
        expect((await activeFirst.json() as { articles: Array<{ id: string }> }).articles.map((item) => item.id)).toEqual([article.id]);
        const listed = await app.request("http://localhost:8787/api/articles", { headers }, environment);
        expect(listed.status).toBe(200);
        expect((await listed.json() as { articles: Array<{ id: string }> }).articles.some((item) => item.id === article.id)).toBe(true);
        const updated = await app.request(`http://localhost:8787/api/articles/${article.id}`, {
          method: "PATCH", headers, body: JSON.stringify({ summary: "Published", published: true }),
        }, environment);
        expect(updated.status).toBe(200);
        await expect(updated.json()).resolves.toMatchObject({ article: { id: article.id, published: true, revision: 2 } });
        const repeated = await app.request(`http://localhost:8787/api/articles/${article.id}`, {
          method: "PATCH", headers, body: JSON.stringify({ summary: "Published", published: true }),
        }, environment);
        expect(repeated.status).toBe(200);
        await expect(repeated.json()).resolves.toMatchObject({ article: { id: article.id, revision: 2 } });
        const beforeDelete = await database.select().from(outboxMessage).where(eq(outboxMessage.resourceId, article.id));
        expect(beforeDelete.map((event) => event.eventName).sort()).toEqual(["resource.article.created", "resource.article.updated"]);
        expect(beforeDelete.find((event) => event.eventName === "resource.article.updated")).toMatchObject({
          organizationId, payload: { resourceId: article.id, revision: 2 },
          idempotencyKey: `${organizationId}:resource.article.updated:${article.id}:2`,
        });
        if (localWebhookEnabled) {
          const updatedOutbox = beforeDelete.find((event) => event.eventName === "resource.article.updated")!;
          const store = new PostgresOutboxStore(databaseUrl!, { assumeApplicationRole: true });
          try {
            const committed = await store.findCommitted(updatedOutbox.id);
            expect(committed).toBeTruthy();
            expect(await projectWebhookForEvent({ envelope: committed!.message, environment: webhookEnvironment, outbox: store })).toMatchObject({ state: "ready", deliveries: 1 });
            expect(await projectWebhookForEvent({ envelope: committed!.message, environment: webhookEnvironment, outbox: store })).toMatchObject({ state: "ready", deliveries: 1, created: false });
          } finally { await store.close(); }
          const messages = await database.select().from(webhookMessage).where(eq(webhookMessage.resourceId, article.id));
          expect(messages.map((message) => message.publicEventType).sort()).toEqual(["resource.article.created", "resource.article.updated"]);
          expect(messages.find((message) => message.publicEventType === "resource.article.updated")?.envelope).toMatchObject({ data: { resourceId: article.id, revision: 2 } });
          const deliveries = await database.select().from(webhookDelivery).where(eq(webhookDelivery.organizationId, organizationId!));
          expect(deliveries.filter((delivery) => messages.some((message) => message.id === delivery.messageId))).toHaveLength(2);
          const attempts = await database.select().from(webhookAttempt).where(eq(webhookAttempt.organizationId, organizationId!));
          expect(attempts).toHaveLength(2);
          const updateDelivery = deliveries.find((delivery) => delivery.messageId === messages.find((message) => message.publicEventType === "resource.article.updated")?.id);
          if (!updateDelivery) throw new Error("Updated article webhook delivery missing");
          await database.update(webhookDelivery).set({ state: "dead", terminalReason: "system_test_failure", completedAt: new Date() }).where(eq(webhookDelivery.id, updateDelivery.id));
          const replayUrl = `http://localhost:8787/api/developer/webhooks/deliveries/${updateDelivery.id}/replay`;
          expect((await app.request(replayUrl, { method: "POST", headers: { ...headers, origin: "https://wrong.example.test" } }, webhookEnvironment)).status).toBe(403);
          expect((await app.request(replayUrl, { method: "POST", headers: secondHeaders }, webhookEnvironment)).status).toBe(404);
          const replayResponse = await app.request(replayUrl, { method: "POST", headers }, webhookEnvironment);
          expect(replayResponse.status).toBe(202);
          const replayBody = await replayResponse.json() as { state: string; replayDeliveryId: string; created: boolean };
          expect(replayBody).toMatchObject({ state: "queued", created: true });
          expect(replayBody.replayDeliveryId).toMatch(/^whd_replay_[0-9a-f]{32}$/u);
          expect((await app.request(replayUrl, { method: "POST", headers }, webhookEnvironment)).status).toBe(200);
          const replayAttempts = await app.request(`http://localhost:8787/api/developer/webhooks/deliveries/${replayBody.replayDeliveryId}/attempts`, { headers }, webhookEnvironment);
          expect(replayAttempts.status).toBe(200);
          expect(await replayAttempts.json()).toEqual({ attempts: [] });
          const replayInspection = await app.request(`http://localhost:8787/api/developer/webhooks/endpoints/${webhookEndpointId}/deliveries`, { headers }, webhookEnvironment);
          expect(await replayInspection.json()).toMatchObject({ deliveries: expect.arrayContaining([expect.objectContaining({ id: updateDelivery.id, activeReplayId: replayBody.replayDeliveryId, replayable: false })]) });
          // Once the source event is past the 14-day replay window, replay is refused rather than queued for a delivery that could never run.
          const createdMessage = messages.find((message) => message.publicEventType === "resource.article.created");
          const createDelivery = deliveries.find((delivery) => delivery.messageId === createdMessage?.id);
          if (!createdMessage || !createDelivery) throw new Error("Created article webhook delivery missing");
          await database.update(webhookDelivery).set({ state: "dead", terminalReason: "system_test_failure", completedAt: new Date() }).where(eq(webhookDelivery.id, createDelivery.id));
          await database.update(outboxMessage).set({ occurredAt: new Date(Date.now() - 15 * 86_400_000) }).where(eq(outboxMessage.id, createdMessage.sourceEventId));
          const expiredReplay = await app.request(`http://localhost:8787/api/developer/webhooks/deliveries/${createDelivery.id}/replay`, { method: "POST", headers }, webhookEnvironment);
          expect(expiredReplay.status).toBe(409);
          expect(await expiredReplay.json()).toEqual({ error: "The source event is outside the 14-day replay window or no longer retained" });
          expect(await database.select().from(webhookDelivery).where(eq(webhookDelivery.replayOfDeliveryId, createDelivery.id))).toEqual([]);
        }
        const removed = await app.request(`http://localhost:8787/api/articles/${article.id}`, { method: "DELETE", headers }, environment);
        expect(removed.status).toBe(204);
        const repeatedDelete = await app.request(`http://localhost:8787/api/articles/${article.id}`, { method: "DELETE", headers }, environment);
        expect(repeatedDelete.status).toBe(404);
        const afterDelete = await database.select().from(outboxMessage).where(eq(outboxMessage.resourceId, article.id));
        expect(afterDelete.map((event) => event.eventName).sort()).toEqual(["resource.article.created", "resource.article.deleted", "resource.article.updated"]);
        expect(afterDelete.find((event) => event.eventName === "resource.article.deleted")).toMatchObject({
          organizationId, payload: { resourceId: article.id, revision: 2 },
          idempotencyKey: `${organizationId}:resource.article.deleted:${article.id}`,
        });
        if (localWebhookEnabled) {
          const deletedOutbox = afterDelete.find((event) => event.eventName === "resource.article.deleted")!;
          const store = new PostgresOutboxStore(databaseUrl!, { assumeApplicationRole: true });
          try {
            const committed = await store.findCommitted(deletedOutbox.id);
            expect(committed).toBeTruthy();
            expect(await projectWebhookForEvent({ envelope: committed!.message, environment: webhookEnvironment, outbox: store })).toMatchObject({ state: "private" });
          } finally { await store.close(); }
          expect((await database.select().from(webhookMessage).where(eq(webhookMessage.resourceId, article.id))).map((message) => message.publicEventType).sort())
            .toEqual(["resource.article.created", "resource.article.updated"]);
        }
        const missing = await app.request(`http://localhost:8787/api/articles/${article.id}`, { headers }, environment);
        expect(missing.status).toBe(404);
        expect((await app.request(`http://localhost:8787/api/articles/${secondArticleId}`, { method: "DELETE", headers: secondHeaders }, environment)).status).toBe(204);
      }
      const unjoined = await app.request("http://localhost:8787/api/billing/subscription", {
        headers: { origin: environment.WEB_ORIGIN, cookie: cookie!, "x-trestle-tenant": crypto.randomUUID() },
      }, environment);
      expect(unjoined.status).toBe(404);
    } finally {
      if (r2ArtifactId) await database.delete(artifactMetadata).where(eq(artifactMetadata.id, r2ArtifactId));
      if (organizationId && webhookEndpointId) {
        await database.delete(webhookAttempt).where(eq(webhookAttempt.organizationId, organizationId));
        await database.delete(webhookDelivery).where(eq(webhookDelivery.organizationId, organizationId));
        await database.delete(webhookMessage).where(eq(webhookMessage.organizationId, organizationId));
        await database.delete(webhookSecretVersion).where(eq(webhookSecretVersion.endpointId, webhookEndpointId));
        await database.delete(webhookSubscription).where(eq(webhookSubscription.endpointId, webhookEndpointId));
        await database.delete(webhookEndpoint).where(eq(webhookEndpoint.id, webhookEndpointId));
      }
      if (articleId) await database.delete(eventInbox).where(eq(eventInbox.idempotencyKey, `resource.article.created:${articleId}`));
      if (articleId) await database.delete(eventInbox).where(eq(eventInbox.idempotencyKey, `system.workflow.retry:${articleId}`));
      if (articleId) await database.delete(outboxMessage).where(eq(outboxMessage.idempotencyKey, `system.workflow.retry:${articleId}`));
      if (secondArticleId) await database.delete(eventInbox).where(eq(eventInbox.idempotencyKey, `resource.article.created:${secondArticleId}`));
      if (articleId) await database.delete(outboxMessage).where(eq(outboxMessage.resourceId, articleId));
      if (secondArticleId) await database.delete(outboxMessage).where(eq(outboxMessage.resourceId, secondArticleId));
      if (organizationId && process.env.TRESTLE_SYSTEM_TEST_ARTICLES === "1") await database.execute(sql`delete from article where organization_id = ${organizationId}`);
      if (secondOrganizationId && process.env.TRESTLE_SYSTEM_TEST_ARTICLES === "1") await database.execute(sql`delete from article where organization_id = ${secondOrganizationId}`);
      if (secondOrganizationId) await database.delete(organizationEntitlement).where(eq(organizationEntitlement.organizationId, secondOrganizationId));
      if (secondOrganizationId) await database.delete(organizationSubscription).where(eq(organizationSubscription.organizationId, secondOrganizationId));
      if (organizationId) await database.delete(organizationEntitlement).where(eq(organizationEntitlement.organizationId, organizationId));
      if (organizationId) await database.delete(organizationSubscription).where(eq(organizationSubscription.organizationId, organizationId));
      if (secondOrganizationId) await database.delete(organization).where(eq(organization.id, secondOrganizationId));
      if (organizationId) await database.delete(organization).where(eq(organization.id, organizationId));
      // Deleting users cascades their application-role assignments.
      if (joinerId) await database.delete(user).where(eq(user.id, joinerId));
      await database.delete(user).where(eq(user.email, email));
      clearCapturedEmails();
    }
  }, 30_000);
});
