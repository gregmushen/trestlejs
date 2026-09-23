import { expect, test } from "@playwright/test";

test("a customer verifies email and switches isolated organizations", async ({ page }) => {
  const nonce = crypto.randomUUID().slice(0, 12);
  const email = `browser-${nonce}@example.test`;
  const password = `Browser-test-${nonce}!`;
  const first = `First ${nonce}`;
  const second = `Second ${nonce}`;

  await page.goto("/sign-up");
  await page.getByRole("textbox", { name: "Name" }).fill("Browser Test");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const captured = page.locator("article").filter({ hasText: email });
  await expect(captured.getByText("Verify your email")).toBeVisible();
  const verificationUrl = await captured.getByRole("link", { name: "Open message link" }).getAttribute("href");
  expect(verificationUrl).toBeTruthy();
  await page.goto(verificationUrl!);

  await page.goto("/sign-in");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Hello, Browser Test" })).toBeVisible();

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
    const headers = { "x-trestle-tenant": organizationId };
    const inspection = await page.context().request.get("http://localhost:42069/api/developer/webhooks/endpoints", { headers });
    expect(inspection.status()).toBe(200);
    expect(await inspection.json()).toEqual({ endpoints: [] });
    expect((await page.context().request.get("http://localhost:42069/api/developer/webhooks/endpoints?limit=101", { headers })).status()).toBe(400);
  }

  const activate = async (organizationId: string, plan: string) => {
    const response = await page.context().request.post("http://localhost:42069/api/dev/billing", {
      headers: { "x-trestle-tenant": organizationId },
      data: { action: "activate", plan },
    });
    expect(response.status()).toBe(200);
  };
  await activate(firstId!, "starter");
  await activate(secondId!, "pro");

  await selector.selectOption(firstId!);
  await expect(selector).toHaveValue(firstId!);
  await page.goto("/settings/billing");
  await expect(page.getByText("Current plan:")).toContainText("starter");
  await page.getByRole("combobox", { name: "Active organization" }).selectOption(secondId!);
  await expect(page.getByText("Current plan:")).toContainText("pro");
  await page.getByRole("combobox", { name: "Active organization" }).selectOption(firstId!);
  await expect(page.getByText("Current plan:")).toContainText("starter");

  if (process.env.TRESTLE_BROWSER_ARTICLES === "1") {
    await page.getByRole("link", { name: "Article" }).click();
    await page.getByRole("textbox", { name: "New Article name" }).fill(`Private ${nonce}`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText(`Private ${nonce}`)).toBeVisible();
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("textbox", { name: "Edit Article name" }).fill(`Edited ${nonce}`);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(`Edited ${nonce}`)).toBeVisible();
    const articles = await page.context().request.get("http://localhost:42069/api/articles", { headers: { "x-trestle-tenant": firstId! } });
    expect(articles.status()).toBe(200);
    const articleId = ((await articles.json()) as { articles: Array<{ id: string }> }).articles[0]?.id;
    expect(articleId).toBeTruthy();
    await page.getByRole("combobox", { name: "Active organization" }).selectOption(secondId!);
    await expect(page.getByText(`Edited ${nonce}`)).not.toBeVisible();
    const headers = { "x-trestle-tenant": secondId! };
    expect((await page.context().request.get(`http://localhost:42069/api/articles/${articleId}`, { headers })).status()).toBe(404);
    expect((await page.context().request.patch(`http://localhost:42069/api/articles/${articleId}`, { headers, data: { name: "Illicit edit" } })).status()).toBe(404);
    expect((await page.context().request.delete(`http://localhost:42069/api/articles/${articleId}`, { headers })).status()).toBe(404);
    await page.getByRole("textbox", { name: "New Article name" }).fill(`Second ${nonce}`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("listitem").getByText(`Second ${nonce}`)).toBeVisible();
    await page.getByRole("combobox", { name: "Active organization" }).selectOption(firstId!);
    await expect(page.getByText(`Edited ${nonce}`)).toBeVisible();
    await expect(page.getByRole("listitem").getByText(`Second ${nonce}`)).not.toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText(`Edited ${nonce}`)).not.toBeVisible();
    await page.getByRole("combobox", { name: "Active organization" }).selectOption(secondId!);
    await expect(page.getByRole("listitem").getByText(`Second ${nonce}`)).toBeVisible();
  }
});
