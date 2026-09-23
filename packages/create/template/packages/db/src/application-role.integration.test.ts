import postgres from "postgres";
import { describe, expect, it } from "vitest";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite("application role assignment persistence", () => {
  it("gives new members no application role and permits grant and revocation without changing organization ownership", async () => {
    const sql = postgres(connectionString!, { max: 1, prepare: false });
    const suffix = crypto.randomUUID();
    const userId = `app-role-user-${suffix}`;
    const organizationId = `app-role-org-${suffix}`;
    const memberId = `app-role-member-${suffix}`;
    try {
      await sql`insert into "user" (id, name, email, updated_at) values (${userId}, 'Test user', ${`${userId}@example.test`}, now())`;
      await sql`insert into organization (id, name, slug, created_at) values (${organizationId}, 'Test organization', ${organizationId}, now())`;
      await sql`insert into member (id, organization_id, user_id, role, created_at) values (${memberId}, ${organizationId}, ${userId}, 'owner', now())`;
      const [initial] = await sql<{ role: string; application_role: string | null }[]>`select role, application_role from member where id = ${memberId}`;
      expect(initial).toEqual({ role: "owner", application_role: null });
      await sql`update member set application_role = 'contributor' where id = ${memberId}`;
      await sql`update member set application_role = null where id = ${memberId}`;
      const [revoked] = await sql<{ role: string; application_role: string | null }[]>`select role, application_role from member where id = ${memberId}`;
      expect(revoked).toEqual({ role: "owner", application_role: null });
    } finally {
      await sql`delete from member where id = ${memberId}`;
      await sql`delete from organization where id = ${organizationId}`;
      await sql`delete from "user" where id = ${userId}`;
      await sql.end();
    }
  });
});
