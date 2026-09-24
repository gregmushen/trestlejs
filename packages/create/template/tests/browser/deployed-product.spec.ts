import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";

import { waitForStagingVerificationLink } from "../../scripts/staging-email.js";

const articleDeclared = existsSync(new URL("../../.trestle/resources/article.json", import.meta.url));

test.skip(process.env.TRESTLE_BROWSER_MODE !== "deployed", "Staging-only provider test");

test("staging signs up through redirected Resend verification and switches organizations", async ({ page }) => {
  const apiKey = process.env.RESEND_API_KEY;
  const apiOrigin = process.env.API_URL;
  if (!apiKey || !apiOrigin) throw new Error("The deployed product gate requires RESEND_API_KEY and API_URL");
  const nonce = crypto.randomUUID().slice(0, 12);
  const email = `trestle-staging-${nonce}@example.test`;
  const password = `Staging-test-${nonce}!`;
  const first = `First ${nonce}`;
  const second = `Second ${nonce}`;
  const sentAfter = new Date();

  await page.goto("/sign-up");
  await page.getByRole("textbox", { name: "Name" }).fill("Staging Test");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  const link = await waitForStagingVerificationLink({ apiKey, originalEmail: email, apiOrigin: new URL(apiOrigin).origin, sentAfter });
  const verification = await page.context().request.get(link, { maxRedirects: 0 });
  expect([200, 302, 303]).toContain(verification.status());

  await page.goto("/sign-in");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Hello, Staging Test" })).toBeVisible();

  const organizationName = page.getByPlaceholder("Acme, Inc.");
  await organizationName.fill(first);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText(`Created ${first}`)).toBeVisible();
  await organizationName.fill(second);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText(`Created ${second}`)).toBeVisible();

  const selector = page.getByRole("combobox", { name: "Active organization" });
  await expect(selector.locator("option")).toHaveCount(3);
  const firstId = await selector.locator("option", { hasText: first }).getAttribute("value");
  const secondId = await selector.locator("option", { hasText: second }).getAttribute("value");
  expect(firstId).toBeTruthy();
  expect(secondId).toBeTruthy();
  expect(firstId).not.toBe(secondId);

  for (const organizationId of [firstId!, secondId!]) {
    const changed = page.waitForResponse((response) => response.url().includes("/api/auth/organization/set-active") && response.request().method() === "POST");
    await selector.selectOption(organizationId);
    expect((await changed).status()).toBe(200);
    await expect(selector).toHaveValue(organizationId);
    const me = await page.context().request.get(`${apiOrigin}/api/me`);
    expect(me.status()).toBe(200);
    expect((await me.json() as { session: { activeOrganizationId?: string } }).session.activeOrganizationId).toBe(organizationId);
    await page.goto("/settings/billing");
    await expect(page.getByText("No active subscription.")).toBeVisible();
  }
  const outsider = await page.context().request.get(`${apiOrigin}/api/billing/subscription`, {
    headers: { "x-trestle-tenant": crypto.randomUUID() },
  });
  expect(outsider.status()).toBe(404);
  await page.goto("/settings/billing");
  await expect(page.getByText("No active subscription.")).toBeVisible();

  if (articleDeclared) {
    const switchOrganization = async (organizationId: string) => {
      const changed = page.waitForResponse((response) => response.url().includes("/api/auth/organization/set-active") && response.request().method() === "POST");
      await selector.selectOption(organizationId);
      expect((await changed).status()).toBe(200);
      await expect(selector).toHaveValue(organizationId);
    };
    const firstName = `Staging first ${nonce}`;
    const editedName = `Staging edited ${nonce}`;
    const secondName = `Staging second ${nonce}`;
    await switchOrganization(firstId!);
    await page.goto("/articles");
    await expect(page.getByRole("heading", { name: "Article" })).toBeVisible();
    await page.getByRole("textbox", { name: "New Article name" }).fill(firstName);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("listitem").getByText(firstName)).toBeVisible();
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("textbox", { name: "Edit Article name" }).fill(editedName);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("listitem").getByText(editedName)).toBeVisible();
    const firstList = await page.context().request.get(`${apiOrigin}/api/articles`, { headers: { "x-trestle-tenant": firstId! } });
    expect(firstList.status()).toBe(200);
    const firstArticle = ((await firstList.json()) as { articles: Array<{ id: string; name: string }> }).articles.find((article) => article.name === editedName);
    expect(firstArticle?.id).toBeTruthy();
    if (!firstArticle) throw new Error("Created staging Article was not returned by the API");

    await switchOrganization(secondId!);
    await expect(page.getByRole("listitem").getByText(editedName)).toHaveCount(0);
    const secondHeaders = { "x-trestle-tenant": secondId! };
    expect((await page.context().request.get(`${apiOrigin}/api/articles/${firstArticle.id}`, { headers: secondHeaders })).status()).toBe(404);
    expect((await page.context().request.patch(`${apiOrigin}/api/articles/${firstArticle.id}`, { headers: secondHeaders, data: { name: "Cross-tenant edit" } })).status()).toBe(404);
    expect((await page.context().request.delete(`${apiOrigin}/api/articles/${firstArticle.id}`, { headers: secondHeaders })).status()).toBe(404);
    await page.getByRole("textbox", { name: "New Article name" }).fill(secondName);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("listitem").getByText(secondName)).toBeVisible();

    await switchOrganization(firstId!);
    await expect(page.getByRole("listitem").getByText(editedName)).toBeVisible();
    await expect(page.getByRole("listitem").getByText(secondName)).toHaveCount(0);
    expect((await page.context().request.delete(`${apiOrigin}/api/articles/${firstArticle.id}`, { headers: { "x-trestle-tenant": firstId! } })).status()).toBe(204);
    await page.reload();
    await expect(page.getByRole("listitem").getByText(editedName)).toHaveCount(0);
    await switchOrganization(secondId!);
    await expect(page.getByRole("listitem").getByText(secondName)).toBeVisible();
  }
});
