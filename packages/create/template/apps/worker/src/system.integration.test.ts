import { createDatabase, organization, user } from "@__TRESTLE_PROJECT_NAME__/db";
import { clearCapturedEmails, listCapturedEmails } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { app } from "./index.js";

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
      const unjoined = await app.request("http://localhost:8787/api/billing/subscription", {
        headers: { origin: environment.WEB_ORIGIN, cookie: cookie!, "x-trestle-tenant": crypto.randomUUID() },
      }, environment);
      expect(unjoined.status).toBe(404);
    } finally {
      if (organizationId) await database.delete(organization).where(eq(organization.id, organizationId));
      await database.delete(user).where(eq(user.email, email));
      clearCapturedEmails();
    }
  });
});
