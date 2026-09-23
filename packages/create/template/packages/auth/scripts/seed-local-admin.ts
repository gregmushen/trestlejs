import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";

import { platformRoles } from "@__TRESTLE_PROJECT_NAME__/authz";

// Seeds the local-only platform operator (username "admin", password "admin")
// used by `trestle dev`. It refuses every non-local database, and the admin
// Worker rejects this account outside APP_ENV=local.

export const localAdmin = { id: "local-admin", email: "admin@trestle.local", password: "admin" } as const;

const connectionString = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
if ((process.env.TRESTLE_ENV ?? "local") !== "local") throw new Error("The default admin account is only seeded for local development");
const host = new URL(connectionString).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`Refusing to seed the default admin account into non-local database host ${host}`);

const sql = postgres(connectionString, { max: 1, prepare: false });
try {
  const password = await hashPassword(localAdmin.password);
  await sql.begin(async (transaction) => {
    await transaction`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${localAdmin.id}, 'Local admin', ${localAdmin.email}, true, now(), now()) on conflict (id) do nothing`;
    await transaction`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values (${`${localAdmin.id}-credential`}, ${localAdmin.id}, 'credential', ${localAdmin.id}, ${password}, now(), now()) on conflict (id) do nothing`;
    for (const role of platformRoles.list()) {
      await transaction`insert into platform_role_assignment (user_id, role, granted_by, reason) select ${localAdmin.id}, ${role.key}, 'trestle dev', 'local development default operator'
        where not exists (select 1 from platform_role_assignment where user_id = ${localAdmin.id} and role = ${role.key} and revoked_at is null)`;
    }
  });
  console.log(`Local admin ready: username "admin", password "${localAdmin.password}" (local only)`);
} finally {
  await sql.end();
}
