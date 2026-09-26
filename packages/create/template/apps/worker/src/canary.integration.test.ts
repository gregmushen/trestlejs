import { createAuth } from "@__TRESTLE_PROJECT_NAME__/auth";
import { auditEvent, createDatabase, eventInbox, member, organization, outboxMessage, user } from "@__TRESTLE_PROJECT_NAME__/db";
import { clearCapturedEmails, listCapturedEmails } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import worker, { app } from "./index.js";

/**
 * The end-to-end canary: one user journey through the local stack that the
 * `local-canary` evidence claim (trestle evidence) records. Extend it with
 * your application's own domain action after the framework steps.
 */
const databaseUrl = process.env.TRESTLE_SYSTEM_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("end-to-end canary", () => {
  it("verifies, signs in, acts, is denied another tenant, audits an admin change, and completes background work", async () => {
    const unique = crypto.randomUUID();
    const email = `canary-${unique}@example.test`;
    const environment = {
      DATABASE_URL: databaseUrl!, DATABASE_DRIVER: "postgres-js" as const,
      BETTER_AUTH_SECRET: "canary-test-secret-with-at-least-thirty-two-characters", BETTER_AUTH_URL: "http://localhost:8787",
      WEB_ORIGIN: "http://localhost:42069", APP_ENV: "local" as const, EMAIL_DELIVERY_MODE: "local" as const, STRIPE_MODE: "local" as const,
    };
    const database = createDatabase(process.env.TRESTLE_SYSTEM_TEST_MIGRATION_URL ?? databaseUrl!, "postgres-js");
    const origin = { origin: environment.WEB_ORIGIN };
    let organizationId: string | undefined;
    const joinerId = `canary-joiner-${unique}`;
    clearCapturedEmails();
    try {
      // 1. Account creation and email verification, through the real auth routes and local mail capture.
      const signUp = await app.request("http://localhost:8787/api/auth/sign-up/email", { method: "POST", headers: { ...origin, "content-type": "application/json" }, body: JSON.stringify({ name: "Canary", email, password: "canary-password-123" }) }, environment);
      expect(signUp.status).toBe(200);
      const link = listCapturedEmails().find((message) => message.to.includes(email))?.text.match(/https?:\/\/\S+/u)?.[0];
      expect([200, 302]).toContain((await app.request(link!, { method: "GET" }, environment)).status);

      // 2. Sign-in.
      const signIn = await app.request("http://localhost:8787/api/auth/sign-in/email", { method: "POST", headers: { ...origin, "content-type": "application/json" }, body: JSON.stringify({ email, password: "canary-password-123" }) }, environment);
      expect(signIn.status).toBe(200);
      const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
      const created = await app.request("http://localhost:8787/api/auth/organization/create", { method: "POST", headers: { ...origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Canary Organization", slug: `canary-${unique}` }) }, environment);
      expect(created.status).toBe(200);
      organizationId = (await created.json() as { id: string }).id;
      const tenant = { ...origin, cookie, "x-trestle-tenant": organizationId };

      // 3. A protected resource operation.
      const upload = await app.request("http://localhost:8787/api/artifacts", { method: "POST", headers: { ...tenant, "content-type": "text/plain" }, body: "canary artifact" }, environment);
      expect(upload.status).toBe(201);
      const artifactId = (await upload.json() as { artifact: { id: string } }).artifact.id;
      expect((await app.request(`http://localhost:8787/api/artifacts/${artifactId}/access`, { headers: tenant }, environment)).status).toBe(200);

      // 4. Denied access: no session, and another tenant's context.
      expect((await app.request(`http://localhost:8787/api/artifacts/${artifactId}/access`, { headers: { ...origin, "x-trestle-tenant": organizationId } }, environment)).status).toBe(401);
      expect([403, 404]).toContain((await app.request(`http://localhost:8787/api/artifacts/${artifactId}/access`, { headers: { ...tenant, "x-trestle-tenant": crypto.randomUUID() } }, environment)).status);

      // 5. An administrative change, audited in the same request.
      await database.insert(user).values({ id: joinerId, name: "Joiner", email: `${joinerId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
      await createAuth(environment).api.addMember({ body: { userId: joinerId, organizationId, role: "member" } });
      const correlationId = `canary-${unique}`;
      const roles = await app.request(`http://localhost:8787/api/tenant/users/${joinerId}/application-roles`, { method: "PUT", headers: { ...tenant, "content-type": "application/json", "x-correlation-id": correlationId }, body: JSON.stringify({ roles: ["reader"] }) }, environment);
      expect(roles.status).toBe(200);
      const [audit] = await database.select().from(auditEvent).where(eq(auditEvent.correlationId, correlationId));
      expect(audit).toMatchObject({ name: "access.application_roles.changed", organizationId, targetId: joinerId, outcome: "succeeded" });

      // 6. Background work: a committed event is dispatched from the outbox and consumed exactly once.
      expect((await app.request("http://localhost:8787/api/dev/billing", { method: "POST", headers: { ...tenant, "content-type": "application/json" }, body: JSON.stringify({ action: "activate", plan: "starter" }) }, environment)).status).toBe(200);
      const [event] = await database.select().from(outboxMessage).where(and(eq(outboxMessage.organizationId, organizationId), like(outboxMessage.eventName, "billing.%"))).limit(1);
      expect(event).toBeDefined();
      const queued: Array<{ id?: string }> = [];
      for (let batch = 0; batch < 100 && !queued.some((body) => body.id === event!.id); batch++) {
        await worker.scheduled(undefined, { ...environment, TRESTLE_EVENTS: { send: async (body: unknown) => { queued.push(body as { id?: string }); } } });
      }
      const message = queued.find((body) => body.id === event!.id);
      expect(message).toBeDefined();
      const delivery: string[] = [];
      expect(await worker.queue({ messages: [{ body: message, ack: () => delivery.push("ack"), retry: () => delivery.push("retry") }] }, environment)).toMatchObject({ acknowledged: 1 });
      expect(delivery).toEqual(["ack"]);
      expect(await database.select({ id: eventInbox.idempotencyKey }).from(eventInbox).where(eq(eventInbox.idempotencyKey, event!.idempotencyKey))).not.toHaveLength(0);
    } finally {
      if (organizationId) {
        await database.delete(auditEvent).where(eq(auditEvent.organizationId, organizationId)).catch(() => undefined);
        await database.delete(member).where(eq(member.organizationId, organizationId)).catch(() => undefined);
        await database.delete(organization).where(eq(organization.id, organizationId)).catch(() => undefined);
      }
      await database.delete(user).where(eq(user.id, joinerId)).catch(() => undefined);
      await database.delete(user).where(eq(user.email, email)).catch(() => undefined);
    }
  });
});
