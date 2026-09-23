import { PostgresBillingProjectionRepository } from "@__TRESTLE_PROJECT_NAME__/billing";
import { artifactMetadata, createDatabase, createTenantDatabase, eventInbox, organization, organizationEntitlement, organizationSubscription, outboxMessage, PostgresArtifactMetadataRepository, user } from "@__TRESTLE_PROJECT_NAME__/db";
import type { EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";
import { clearCapturedEmails, listCapturedEmails } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { TrestleWorkflow } from "./cloudflare-workflow.js";
import { runArtifactReferenceAudit } from "./artifact-reference-audit.js";
import worker, { app } from "./index.js";

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
    let articleId: string | undefined;
    let secondArticleId: string | undefined;
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
      const access = await app.request(`http://localhost:8787/api/artifacts/${artifactId}/access`, { headers: artifactHeaders }, environment);
      expect(access.status).toBe(200);
      const signedUrl = (await access.json() as { url: string }).url;
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
        await worker.scheduled(undefined, {
          ...environment,
          TRESTLE_EVENTS: { send: async (body: unknown) => { queued.push(body); } },
        });
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
        const workflow = Object.assign(new TrestleWorkflow(), { env: environment });
        const workflowEvent = { payload: workflowInstances.get(outbox!.id)!, instanceId: outbox!.id, timestamp: new Date(), workflowName: "test-workflow" };
        const stepNames: string[] = [];
        const stepConfigs: unknown[] = [];
        const step = { do: async (name: string, config: unknown, callback: () => Promise<void>) => { stepNames.push(name); stepConfigs.push(config); await callback(); } } as Parameters<TrestleWorkflow["run"]>[1];
        await workflow.run(workflowEvent, step);
        await workflow.run(workflowEvent, step);
        expect(stepNames).toEqual(["consume-event-v1", "consume-event-v1"]);
        expect(stepConfigs[0]).toMatchObject({ retries: { limit: 5, backoff: "exponential" }, timeout: "2 minutes" });
        const duplicateDelivery: string[] = [];
        expect(await worker.queue({ messages: [{ body: queuedEvent, ack: () => duplicateDelivery.push("ack"), retry: () => duplicateDelivery.push("retry") }] }, workflowEnvironment)).toEqual({ acknowledged: 1, retried: 0 });
        expect(duplicateDelivery).toEqual(["ack"]);
        const [inbox] = await database.select().from(eventInbox).where(eq(eventInbox.idempotencyKey, outbox!.idempotencyKey)).limit(1);
        expect(inbox).toMatchObject({ status: "completed", attempts: 1 });
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
        await expect(updated.json()).resolves.toMatchObject({ article: { id: article.id, published: true } });
        const removed = await app.request(`http://localhost:8787/api/articles/${article.id}`, { method: "DELETE", headers }, environment);
        expect(removed.status).toBe(204);
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
      if (articleId) await database.delete(eventInbox).where(eq(eventInbox.idempotencyKey, `resource.article.created:${articleId}`));
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
      await database.delete(user).where(eq(user.email, email));
      clearCapturedEmails();
    }
  }, 30_000);
});
