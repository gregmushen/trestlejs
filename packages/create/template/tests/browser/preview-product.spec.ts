import { expect, test } from "@playwright/test";

import { waitForStagingVerificationLink } from "../../scripts/staging-email.js";

test.skip(process.env.TRESTLE_BROWSER_MODE !== "deployed", "Deployed preview only");

test("preview verifies redirected email and tenant-safe test Checkout", async ({ page }) => {
  test.setTimeout(180_000);
  const apiKey = process.env.RESEND_API_KEY;
  const apiOrigin = process.env.API_URL;
  if (!apiKey || !apiOrigin) throw new Error("Preview product verification requires RESEND_API_KEY and API_URL");
  const nonce = crypto.randomUUID().slice(0, 12);
  const email = `trestle-preview-${nonce}@example.test`;
  const password = `Preview-test-${nonce}!`;
  const sentAfter = new Date();

  await page.goto("/sign-up");
  await page.getByRole("textbox", { name: "Name" }).fill("Preview Test");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const link = await waitForStagingVerificationLink({ apiKey, originalEmail: email, apiOrigin: new URL(apiOrigin).origin, sentAfter, environment: "preview" });
  const verification = await page.context().request.get(link, { maxRedirects: 0 });
  expect([200, 302, 303]).toContain(verification.status());

  await page.goto("/sign-in");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Hello, Preview Test" })).toBeVisible();
  const organizationName = page.getByPlaceholder("Acme, Inc.");
  for (const name of [`First ${nonce}`, `Second ${nonce}`]) {
    await organizationName.fill(name);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText(`Created ${name}`)).toBeVisible();
  }
  const selector = page.getByRole("combobox", { name: "Active organization" });
  const firstId = await selector.locator("option", { hasText: `First ${nonce}` }).getAttribute("value");
  const secondId = await selector.locator("option", { hasText: `Second ${nonce}` }).getAttribute("value");
  expect(firstId).toBeTruthy();
  expect(secondId).toBeTruthy();
  expect(firstId).not.toBe(secondId);

  const switched = page.waitForResponse((response) => response.url().includes("/api/auth/organization/set-active") && response.request().method() === "POST");
  await selector.selectOption(firstId!);
  expect((await switched).status()).toBe(200);
  const me = await page.context().request.get(`${apiOrigin}/api/me`);
  expect((await me.json() as { session: { activeOrganizationId?: string } }).session.activeOrganizationId).toBe(firstId);

  const headers = { "content-type": "application/json", "x-trestle-tenant": firstId! };
  const input = { plan: "pro", requestId: `preview-${nonce}` };
  const checkoutRequest = () => page.context().request.post(`${apiOrigin}/api/billing/checkout`, { headers, data: input });
  const checkoutResponse = await checkoutRequest();
  expect(checkoutResponse.status()).toBe(200);
  const checkout = await checkoutResponse.json() as { id: string; url: string };
  expect(checkout.id).toMatch(/^cs_test_/u);
  expect(new URL(checkout.url).origin).toBe("https://checkout.stripe.com");
  const checkoutRetry = await checkoutRequest();
  expect(checkoutRetry.status()).toBe(200);
  expect((await checkoutRetry.json() as { id: string }).id).toBe(checkout.id);
  const subscription = await page.context().request.get(`${apiOrigin}/api/billing/subscription`, { headers });
  expect(subscription.status()).toBe(200);
  expect((await subscription.json() as { subscription: unknown }).subscription).toBeNull();
  const forged = await page.context().request.post(`${apiOrigin}/api/billing/checkout`, {
    headers: { ...headers, "x-trestle-tenant": crypto.randomUUID() }, data: input,
  });
  expect(forged.status()).toBe(404);
});
