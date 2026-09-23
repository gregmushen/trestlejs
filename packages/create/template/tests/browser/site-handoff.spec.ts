import { expect, test } from "@playwright/test";

const siteURL = process.env.SITE_URL ?? `http://localhost:${process.env.TRESTLE_BROWSER_SITE_PORT ?? 42068}`;
const appURL = process.env.APP_URL ?? "http://localhost:42069";
const apiURL = process.env.API_URL ?? "http://localhost:8787";

test("Southwind hands off to hydrated app routes and browser-accessible API", async ({ page }) => {
  await page.goto(siteURL);
  const signInURL = new URL("/sign-in", appURL).toString();
  await expect(page.getByRole("link", { name: "Sign in" }).first()).toHaveAttribute("href", signInURL);
  await page.getByRole("link", { name: "Sign in" }).first().click();
  await expect(page).toHaveURL(signInURL);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

  const health = await page.evaluate(async (origin) => {
    const response = await fetch(`${origin}/api/health`);
    return { status: response.status, body: await response.json() as { status?: string } };
  }, apiURL);
  expect(health).toMatchObject({ status: 200, body: { status: "ok" } });

  await page.goto(new URL("/pricing", siteURL).toString());
  const proURL = new URL("/sign-up?plan=pro", appURL).toString();
  await page.locator(`a[href="${proURL}"]`).click();
  await expect(page).toHaveURL(proURL);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

  await page.goto(new URL("/settings/billing", appURL).toString());
  await expect(page.getByRole("heading", { name: "Plan and usage" })).toBeVisible();
  await expect(page.getByText("Select an organization to view billing.")).toBeVisible();
});
