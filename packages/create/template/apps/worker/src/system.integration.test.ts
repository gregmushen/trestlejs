import { createDatabase, organization, outboxMessage, user } from "@__TRESTLE_PROJECT_NAME__/db";
import { clearCapturedEmails, listCapturedEmails } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
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
    const database = createDatabase(databaseUrl!, "postgres-js");
    let organizationId: string | undefined;
    let articleId: string | undefined;
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

      const billing = await app.request("http://localhost:8787/api/billing/subscription", {
        headers: { origin: environment.WEB_ORIGIN, cookie: cookie!, "x-trestle-tenant": organizationId! },
      }, environment);
      expect(billing.status).toBe(200);
      await expect(billing.json()).resolves.toHaveProperty("subscription");
      if (process.env.TRESTLE_SYSTEM_TEST_ARTICLES === "1") {
        const headers = { origin: environment.WEB_ORIGIN, cookie: cookie!, "x-trestle-tenant": organizationId!, "content-type": "application/json" };
        const createdArticle = await app.request("http://localhost:8787/api/articles", {
          method: "POST", headers, body: JSON.stringify({ name: "System Article", summary: "Draft", published: false }),
        }, environment);
        expect(createdArticle.status).toBe(201);
        const { article } = await createdArticle.json() as { article: { id: string } };
        articleId = article.id;
        const [outbox] = await database.select().from(outboxMessage).where(eq(outboxMessage.resourceId, article.id)).limit(1);
        expect(outbox).toMatchObject({ eventName: "resource.article.created", resourceType: "article", resourceId: article.id, status: "pending", payload: { organizationId, resourceId: article.id } });
        expect(outbox?.correlationId).toBeTruthy();
        const queued: unknown[] = [];
        await worker.scheduled(undefined, {
          ...environment,
          TRESTLE_EVENTS: { send: async (body: unknown) => { queued.push(body); } },
        });
        expect(queued).toMatchObject([{ id: outbox!.id, name: "resource.article.created", resource: { type: "article", id: article.id } }]);
        const delivery: string[] = [];
        expect(await worker.queue({ messages: [{ body: queued[0], ack: () => delivery.push("ack"), retry: () => delivery.push("retry") }] }, environment)).toEqual({ acknowledged: 1, retried: 0 });
        expect(delivery).toEqual(["ack"]);
        const invalidDelivery: string[] = [];
        expect(await worker.queue({ messages: [{ body: { ...(queued[0] as object), payload: { resourceId: article.id } }, ack: () => invalidDelivery.push("ack"), retry: () => invalidDelivery.push("retry") }] }, environment)).toEqual({ acknowledged: 0, retried: 1 });
        expect(invalidDelivery).toEqual(["retry"]);
        const [dispatched] = await database.select().from(outboxMessage).where(eq(outboxMessage.id, outbox!.id)).limit(1);
        expect(dispatched?.status).toBe("succeeded");
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
      }
      const unjoined = await app.request("http://localhost:8787/api/billing/subscription", {
        headers: { origin: environment.WEB_ORIGIN, cookie: cookie!, "x-trestle-tenant": crypto.randomUUID() },
      }, environment);
      expect(unjoined.status).toBe(404);
    } finally {
      if (articleId) await database.delete(outboxMessage).where(eq(outboxMessage.resourceId, articleId));
      if (organizationId && process.env.TRESTLE_SYSTEM_TEST_ARTICLES === "1") await database.execute(sql`delete from article where organization_id = ${organizationId}`);
      if (organizationId) await database.delete(organization).where(eq(organization.id, organizationId));
      await database.delete(user).where(eq(user.email, email));
      clearCapturedEmails();
    }
  });
});
