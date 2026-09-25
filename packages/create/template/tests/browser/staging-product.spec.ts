import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

const articleDeclared = existsSync(new URL("../../.trestle/resources/article.json", import.meta.url));

test.skip(process.env.TRESTLE_BROWSER_MODE !== "deployed" || process.env.TRESTLE_DEPLOY_ENV !== "staging", "Staging product test requires the protected staging deployment");

test("staging verifies authenticated tenant isolation without sending email", async ({ page }) => {
  test.setTimeout(180_000);
  const email = process.env.TRESTLE_STAGING_FIXTURE_EMAIL;
  const password = process.env.TRESTLE_STAGING_FIXTURE_PASSWORD;
  const appOrigin = process.env.APP_URL;
  if (!email || !password || !appOrigin) throw new Error("Staging product verification requires a staging fixture and APP_URL");

  await page.goto("/sign-in");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Hello, Staging Fixture" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  const selector = page.getByRole("combobox", { name: "Active organization" });
  const organizationName = page.getByPlaceholder("Acme, Inc.");
  const names = ["Trestle Staging Fixture A", "Trestle Staging Fixture B"] as const;
  for (const name of names) {
    if (await selector.locator("option", { hasText: name }).count() === 0) {
      await organizationName.fill(name);
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page.getByText(`Created ${name}`)).toBeVisible();
      await expect(selector.locator("option", { hasText: name })).toHaveCount(1);
    }
  }
  const firstId = await selector.locator("option", { hasText: names[0] }).getAttribute("value");
  const secondId = await selector.locator("option", { hasText: names[1] }).getAttribute("value");
  expect(firstId).toBeTruthy();
  expect(secondId).toBeTruthy();
  expect(firstId).not.toBe(secondId);

  for (const organizationId of [firstId!, secondId!]) {
    const changed = page.waitForResponse((response) => response.url().includes("/api/auth/organization/set-active") && response.request().method() === "POST");
    await selector.selectOption(organizationId);
    expect((await changed).status()).toBe(200);
    const me = await page.context().request.get(`${appOrigin}/api/me`);
    expect(me.status()).toBe(200);
    expect((await me.json() as { session: { activeOrganizationId?: string } }).session.activeOrganizationId).toBe(organizationId);
  }
  const outsider = await page.context().request.get(`${appOrigin}/api/billing/subscription`, {
    headers: { "x-trestle-tenant": crypto.randomUUID() },
  });
  expect(outsider.status()).toBe(404);

  if (articleDeclared) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("Staging Article RLS verification requires the runtime DATABASE_URL");
    const name = `Staging isolation ${crypto.randomUUID()}`;
    const firstHeaders = { "x-trestle-tenant": firstId! };
    const secondHeaders = { "x-trestle-tenant": secondId! };
    const switchOrganization = async (organizationId: string) => {
      const changed = page.waitForResponse((response) => response.url().includes("/api/auth/organization/set-active") && response.request().method() === "POST");
      await selector.selectOption(organizationId);
      expect((await changed).status()).toBe(200);
    };
    await switchOrganization(firstId!);
    const created = await page.context().request.post(`${appOrigin}/api/articles`, { headers: firstHeaders, data: { name } });
    expect(created.status()).toBe(201);
    const article = (await created.json() as { article: { id: string } }).article;
    expect(article.id).toBeTruthy();
    try {
      await switchOrganization(secondId!);
      expect((await page.context().request.get(`${appOrigin}/api/articles/${article.id}`, { headers: secondHeaders })).status()).toBe(404);
      expect((await page.context().request.patch(`${appOrigin}/api/articles/${article.id}`, { headers: secondHeaders, data: { name: "Forbidden" } })).status()).toBe(404);
      expect((await page.context().request.delete(`${appOrigin}/api/articles/${article.id}`, { headers: secondHeaders })).status()).toBe(404);
      const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
      try {
        const [table] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
          select relrowsecurity, relforcerowsecurity from pg_class where oid = to_regclass('public.article')
        `;
        expect(table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
        const [role] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
        expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
        await sql.begin(async (transaction) => {
          await transaction`select set_config('app.organization_id', ${firstId!}, true)`;
          expect(await transaction`select id from article where id = ${article.id}`).toHaveLength(1);
          await transaction`select set_config('app.organization_id', ${secondId!}, true)`;
          expect(await transaction`select id from article where id = ${article.id}`).toHaveLength(0);
        });
      } finally {
        await sql.end();
      }
    } finally {
      await switchOrganization(firstId!);
      await page.context().request.delete(`${appOrigin}/api/articles/${article.id}`, { headers: firstHeaders });
    }
  }
});
