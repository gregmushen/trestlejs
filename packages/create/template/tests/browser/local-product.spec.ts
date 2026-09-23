import { expect, test } from "@playwright/test";
import postgres from "postgres";

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
  const switchOrganization = async (organizationId: string) => {
    const changed = page.waitForResponse((response) => response.url().includes("/api/auth/organization/set-active") && response.request().method() === "POST");
    await page.getByRole("combobox", { name: "Active organization" }).selectOption(organizationId);
    expect((await changed).status()).toBe(200);
    await expect(page.getByRole("combobox", { name: "Active organization" })).toHaveValue(organizationId);
  };
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
    expect((await page.context().request.post("http://localhost:42069/api/developer/webhooks/endpoints", {
      headers: { ...headers, origin: "https://attacker.example" },
      data: { name: "Rejected", destinationUrl: "https://hooks.example.com/receive", subscriptions: [{ type: "article.published", version: 1 }] },
    })).status()).toBe(403);
    expect((await page.context().request.post("http://localhost:42069/api/developer/webhooks/endpoints", {
      headers: { ...headers, origin: "http://localhost:42069" },
      data: { name: "Missing key", destinationUrl: "https://hooks.example.com/receive", subscriptions: [{ type: "article.published", version: 1 }] },
    })).status()).toBe(503);
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

  await switchOrganization(firstId!);
  await expect(selector).toHaveValue(firstId!);
  await page.getByRole("link", { name: "Webhooks" }).click();
  await expect(page.getByRole("heading", { name: "Outbound webhooks" })).toBeVisible();
  await expect(page.getByText("No webhook endpoints for this organization.")).toBeVisible();
  await switchOrganization(secondId!);
  await page.goto("/settings/billing");
  await expect(page.getByText("Current plan:")).toContainText("pro");
  await page.goto("/settings/webhooks");
  await expect(page.getByText("No webhook endpoints for this organization.")).toBeVisible();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("No webhook endpoints for this organization.")).toBeVisible();
  if (process.env.TRESTLE_BROWSER_MODE !== "deployed") {
    const newEndpointId = "11719456-3380-43e5-8a06-d4da18623cc9";
    const oneTimeSecret = "whsec_browser-only-once";
    let registered = false;
    let selectedEvents = [{ type: "article.published", version: 1 }];
    await page.route("**/api/developer/webhooks/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/subscriptions") && route.request().method() === "PATCH") selectedEvents = (route.request().postDataJSON() as { subscriptions: typeof selectedEvents }).subscriptions;
      const json = path.endsWith("/events") ? { events: [{ type: "article.published", version: 1, description: "An article was published", available: true }, { type: "article.deleted", version: 1, description: "An article was deleted", available: true }] }
        : path.endsWith("/subscriptions") ? { subscriptions: selectedEvents }
        : path.endsWith("/deliveries") ? { deliveries: [] }
        : path.endsWith("/attempts") ? { attempts: [] }
        : route.request().method() === "POST" ? { endpoint: { id: newEndpointId, state: "disabled" }, signingSecret: oneTimeSecret }
        : { endpoints: registered ? [{ id: newEndpointId, name: "Browser receiver", destinationHost: "hooks.example.com", state: "disabled", health: "unknown", provider: "local", subscriptionCount: 1, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" }] : [] };
      if (route.request().method() === "POST") registered = true;
      await route.fulfill({ status: route.request().method() === "POST" ? 201 : 200, contentType: "application/json", body: JSON.stringify(json) });
    });
    await page.reload();
    await page.getByRole("textbox", { name: "Endpoint name" }).fill("Browser receiver");
    await page.getByRole("textbox", { name: "HTTPS destination" }).fill("https://hooks.example.com/receive");
    await page.getByRole("checkbox", { name: /article.published v1/u }).check();
    await page.getByRole("button", { name: "Create endpoint" }).click();
    await expect(page.getByText(oneTimeSecret)).toBeVisible();
    await expect(page.getByText("Save this signing secret now. It cannot be recovered.")).toBeVisible();
    await page.getByRole("button", { name: "I saved it; hide secret" }).click();
    await expect(page.getByText(oneTimeSecret)).toHaveCount(0);
    const subscriptionEditor = page.getByRole("region", { name: "Endpoint subscriptions" });
    await expect(subscriptionEditor.getByRole("heading", { name: "Subscriptions" })).toBeVisible();
    await subscriptionEditor.getByRole("checkbox", { name: /article.deleted v1/u }).check();
    await subscriptionEditor.getByRole("checkbox", { name: /article.published v1/u }).uncheck();
    await subscriptionEditor.getByRole("button", { name: "Save subscriptions" }).click();
    await expect(subscriptionEditor.getByText("Subscriptions saved.")).toBeVisible();
    expect(selectedEvents).toEqual([{ type: "article.deleted", version: 1 }]);
    await page.unroute("**/api/developer/webhooks/**");

    const endpointId = "c45cf83d-1341-4242-a57d-5bb6c6266f85";
    const deliveryId = `whd_${"a".repeat(64)}`;
    const sensitive = "never-render-this-webhook-secret";
    let forbidden = false;
    await page.route("**/api/developer/webhooks/**", async (route) => {
      if (forbidden) { await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Forbidden" }) }); return; }
      const path = new URL(route.request().url()).pathname;
      const body = path.endsWith("/events") ? { events: [] }
        : path.endsWith("/subscriptions") ? { subscriptions: [{ type: "article.published", version: 1 }] }
        : path.endsWith("/attempts") ? { attempts: [{ id: `${deliveryId}.1`, attemptNumber: 1, kind: "native", attemptedAt: "2026-09-23T00:00:00.000Z", completedAt: "2026-09-23T00:00:01.000Z", responseStatus: 503, resultCategory: "http", outcome: "retry", durationMs: 1000, nextRetryAt: null, requestBody: sensitive }] }
        : path.endsWith("/deliveries") ? { deliveries: [{ id: deliveryId, messageId: "hidden-message", eventType: "article.published", eventVersion: 1, occurredAt: "2026-09-23T00:00:00.000Z", state: "retry", attemptCount: 1, nextAttemptAt: null, terminalReason: null, createdAt: "2026-09-23T00:00:00.000Z", completedAt: null, payloadAvailable: true, correlationId: null, envelope: sensitive }] }
        : { endpoints: [{ id: endpointId, name: "Product events", destinationHost: "hooks.example.test", state: "active", health: "healthy", provider: "native", subscriptionCount: 1, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z", destinationUrl: `https://hooks.example.test/${sensitive}` }] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.getByRole("button", { name: "Refresh" }).click();
    await page.getByRole("button", { name: /Product events/u }).click();
    await expect(page.getByRole("button", { name: /Product events/u })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: /article.published v1/u }).click();
    await expect(page.getByText("Attempt 1: retry")).toBeVisible();
    await expect(page.getByText(sensitive)).toHaveCount(0);
    forbidden = true;
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByRole("alert").first()).toHaveText("You do not have permission to inspect this organization's webhooks.");
    await page.unroute("**/api/developer/webhooks/**");
  }
  await page.goto("/settings/billing");
  await expect(page.getByText("Current plan:")).toContainText("pro");
  await switchOrganization(firstId!);
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
    if (!articleId) throw new Error("Created article was not returned by the list API");
    if (process.env.TRESTLE_BROWSER_DATABASE_URL) {
      const database = postgres(process.env.TRESTLE_BROWSER_DATABASE_URL, { max: 1, prepare: false });
      try {
        const committed = await database`select organization_id, event_name, schema_version, resource_type, resource_id, correlation_id, idempotency_key, payload
          from outbox_message where resource_id=${articleId}`;
        expect(committed).toHaveLength(1);
        expect(committed[0]).toMatchObject({ organization_id: firstId, event_name: "resource.article.created",
          schema_version: 1, resource_type: "article", resource_id: articleId,
          idempotency_key: `${firstId}:resource.article.created:${articleId}`, payload: { resourceId: articleId } });
        expect(committed[0]?.correlation_id).toEqual(expect.any(String));
      } finally { await database.end(); }
    }
    await switchOrganization(secondId!);
    await expect(page.getByText(`Edited ${nonce}`)).not.toBeVisible();
    const headers = { "x-trestle-tenant": secondId! };
    expect((await page.context().request.get(`http://localhost:42069/api/articles/${articleId}`, { headers })).status()).toBe(404);
    expect((await page.context().request.patch(`http://localhost:42069/api/articles/${articleId}`, { headers, data: { name: "Illicit edit" } })).status()).toBe(404);
    expect((await page.context().request.delete(`http://localhost:42069/api/articles/${articleId}`, { headers })).status()).toBe(404);
    await page.getByRole("textbox", { name: "New Article name" }).fill(`Second ${nonce}`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("listitem").getByText(`Second ${nonce}`)).toBeVisible();
    await switchOrganization(firstId!);
    await expect(page.getByText(`Edited ${nonce}`)).toBeVisible();
    await expect(page.getByRole("listitem").getByText(`Second ${nonce}`)).not.toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText(`Edited ${nonce}`)).not.toBeVisible();
    await switchOrganization(secondId!);
    await expect(page.getByRole("listitem").getByText(`Second ${nonce}`)).toBeVisible();
  }
});
