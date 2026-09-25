import { expect, test } from "@playwright/test";

test.skip(process.env.TRESTLE_BROWSER_MODE !== "deployed" || process.env.TRESTLE_DEPLOY_ENV !== "preview", "Preview product test requires an isolated deployment");

test("preview verifies deployed sign-in, tenant-safe test Checkout, and webhook entitlements without sending email", async ({ page }) => {
  test.setTimeout(180_000);
  const email = process.env.TRESTLE_PREVIEW_FIXTURE_EMAIL;
  const password = process.env.TRESTLE_PREVIEW_FIXTURE_PASSWORD;
  const appOrigin = process.env.APP_URL;
  if (!email || !password || !appOrigin) throw new Error("Preview product verification requires a verified preview fixture and APP_URL");
  const nonce = crypto.randomUUID().slice(0, 12);

  await page.goto("/sign-in");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Hello, Preview Fixture" })).toBeVisible();
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
  const me = await page.context().request.get(`${appOrigin}/api/me`);
  expect((await me.json() as { session: { activeOrganizationId?: string } }).session.activeOrganizationId).toBe(firstId);

  const headers = { "content-type": "application/json", "x-trestle-tenant": firstId! };
  const input = { plan: "pro", requestId: `preview-${nonce}` };
  const checkoutRequest = () => page.context().request.post(`${appOrigin}/api/billing/checkout`, { headers, data: input });
  const checkoutResponse = await checkoutRequest();
  expect(checkoutResponse.status()).toBe(200);
  const checkout = await checkoutResponse.json() as { id: string; url: string };
  expect(checkout.id).toMatch(/^cs_test_/u);
  expect(new URL(checkout.url).origin).toBe("https://checkout.stripe.com");
  const checkoutRetry = await checkoutRequest();
  expect(checkoutRetry.status()).toBe(200);
  expect((await checkoutRetry.json() as { id: string }).id).toBe(checkout.id);
  const subscription = await page.context().request.get(`${appOrigin}/api/billing/subscription`, { headers });
  expect(subscription.status()).toBe(200);
  expect((await subscription.json() as { subscription: unknown }).subscription).toBeNull();
  const forged = await page.context().request.post(`${appOrigin}/api/billing/checkout`, {
    headers: { ...headers, "x-trestle-tenant": crypto.randomUUID() }, data: input,
  });
  expect(forged.status()).toBe(404);

  await page.goto(checkout.url);
  const cardChoice = page.getByRole("radio", { name: "Card", exact: true });
  const cardNumber = page.locator('input[name="cardNumber"]');
  // Stripe may show Card as a choice or select it without a radio control.
  await expect.poll(async () => await cardChoice.isVisible() || await cardNumber.isVisible(), { timeout: 30_000 }).toBe(true);
  if (await cardChoice.isVisible()) await cardChoice.check({ force: true });
  await cardNumber.fill("4242424242424242");
  await page.locator('input[name="cardExpiry"]').fill("12/34");
  await page.locator('input[name="cardCvc"]').fill("123");
  await page.locator('input[name="billingName"]').fill("Trestle Preview Test");
  await page.locator('input[name="billingPostalCode"]').fill("94105");
  await page.getByRole("checkbox", { name: "Save my information for faster checkout" }).uncheck();
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  await page.waitForURL((url) => url.origin === appOrigin && url.pathname === "/settings/billing" && url.searchParams.get("checkout") === "success", { timeout: 60_000 });
  await expect.poll(async () => {
    const response = await page.context().request.get(`${appOrigin}/api/billing/subscription`, { headers });
    if (!response.ok()) return `HTTP ${response.status()}`;
    const body = await response.json() as { subscription: { status?: string } | null };
    return body.subscription?.status ?? "none";
  }, { timeout: 60_000, intervals: [1000, 2000, 5000] }).toBe("active");
  const paid = await page.context().request.get(`${appOrigin}/api/billing/subscription`, { headers });
  expect(await paid.json()).toMatchObject({ subscription: { provider: "stripe", plan: "pro", entitlements: expect.arrayContaining(["workflows.advanced"]) } });
});
