import { expect, test } from "@playwright/test";

import { waitForStagingVerificationLink } from "../../scripts/staging-email.js";

test.skip(process.env.TRESTLE_BROWSER_MODE !== "deployed" || process.env.TRESTLE_DEPLOY_ENV !== "preview" || process.env.TRESTLE_ALLOW_LIVE_EMAIL_TESTS !== "1", "Live Resend email tests require explicit opt-in");

test("preview sends one redirected verification email and accepts its link", async ({ page }) => {
  test.setTimeout(180_000);
  const apiKey = process.env.RESEND_API_KEY;
  const apiOrigin = process.env.API_URL;
  if (!apiKey || !apiOrigin) throw new Error("Live email verification requires RESEND_API_KEY and API_URL");
  const nonce = crypto.randomUUID().slice(0, 12);
  const email = `trestle-preview-${nonce}@example.test`;
  const password = `Preview-test-${nonce}!`;
  const sentAfter = new Date();

  await page.goto("/sign-up");
  await page.getByRole("textbox", { name: "Name" }).fill("Preview Email Test");
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
  await expect(page.getByRole("heading", { name: "Hello, Preview Email Test" })).toBeVisible();
});
