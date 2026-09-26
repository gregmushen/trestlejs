import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

test("View as Alice stays in the customer app, read-only, and ends from its banner", async ({ page }) => {
  const databaseUrl = process.env.TRESTLE_BROWSER_DATABASE_URL;
  test.skip(!databaseUrl, "This local-only browser scenario needs its isolated PostgreSQL database");
  const sql = postgres(databaseUrl!, { max: 1, prepare: false });
  const run = `browser-support-${randomUUID().slice(0, 12)}`;
  const operatorId = `${run}-operator`;
  const viewedUserId = `${run}-alice`;
  const organizationId = `${run}-org`;
  const sessionId = randomUUID();
  const handoff = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(handoff).digest("hex");
  try {
    await sql`insert into "user" (id, name, email, email_verified, created_at, updated_at) values
      (${operatorId}, 'Greg', ${`${run}-greg@example.test`}, true, now(), now()),
      (${viewedUserId}, 'Alice', ${`${run}-alice@example.test`}, true, now(), now())`;
    await sql`insert into organization (id, name, slug, created_at) values (${organizationId}, 'Acme', ${organizationId}, now())`;
    await sql`insert into member (id, organization_id, user_id, role, created_at) values (${`${run}-member`}, ${organizationId}, ${viewedUserId}, 'member', now())`;
    await sql`insert into platform_role_assignment (user_id, role, granted_by, reason) values (${operatorId}, 'platform_operator', 'system:browser', 'browser test')`;
    await sql`insert into support_session (id, organization_id, operator_id, target_user_id, reason, expires_at, correlation_id)
      values (${sessionId}, ${organizationId}, ${operatorId}, ${viewedUserId}, 'Browser support test', now() + interval '30 minutes', ${run})`;
    await sql`insert into support_handoff (session_id, token_hash, expires_at) values (${sessionId}, ${tokenHash}, now() + interval '1 minute')`;

    await page.goto(`/support/view#handoff=${handoff}`);
    await expect(page.getByRole("region", { name: "Read-only support view" })).toContainText("Viewing as Alice — read only");
    await expect(page.getByRole("heading", { name: "Hello, Alice" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Read-only support view" })).toContainText(`${run}-greg@example.test`);
    expect(new URL(page.url()).hash).toBe("");
    const cookies = await page.context().cookies();
    expect(cookies).toEqual(expect.arrayContaining([expect.objectContaining({ name: "trestle_support_view", httpOnly: true })]));
    expect(cookies.some((cookie) => cookie.name.includes("better-auth"))).toBe(false);
    const mutationStatus = await page.evaluate(async () => (await fetch("/api/billing/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
    expect(mutationStatus).toBe(403);

    await page.getByRole("button", { name: "Exit support view" }).click();
    await expect(page).toHaveURL(/\/$/u);
    const [ended] = await sql`select ended_at, ended_by from support_session where id = ${sessionId}`;
    expect(ended?.ended_at).not.toBeNull();
    expect(ended?.ended_by).toBe(`platform_operator:${operatorId}`);
  } finally {
    await sql`delete from audit_event where organization_id = ${organizationId}`;
    await sql`delete from support_view_grant where session_id = ${sessionId}`;
    await sql`delete from support_handoff where session_id = ${sessionId}`;
    await sql`delete from support_session where id = ${sessionId}`;
    await sql`delete from platform_role_assignment where user_id = ${operatorId}`;
    await sql`delete from member where organization_id = ${organizationId}`;
    await sql`delete from organization where id = ${organizationId}`;
    await sql`delete from "user" where id in (${operatorId}, ${viewedUserId})`;
    await sql.end();
  }
});
