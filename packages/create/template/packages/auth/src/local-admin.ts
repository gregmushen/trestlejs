import { platformRoles } from "@__TRESTLE_PROJECT_NAME__/authz";
import { account, activePlatformRoles, createDatabase, grantPlatformRole, user } from "@__TRESTLE_PROJECT_NAME__/db";
import { hashPassword } from "better-auth/crypto";

/**
 * The local-only default platform operator: username "admin", password
 * "admin" (admin@trestle.local), holding every platform role. It is seeded
 * only into a database on this machine, and the admin Worker refuses the
 * account outside APP_ENV=local, so it can never operate a deployed platform.
 */
export const localAdmin = { id: "local-admin", email: "admin@trestle.local", username: "admin", password: "admin" } as const;

const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export async function seedLocalAdmin(connectionString: string): Promise<{ granted: string[] }> {
  if ((process.env.TRESTLE_ENV ?? process.env.APP_ENV ?? "local") !== "local") throw new Error("The default admin account is only seeded for local development");
  const host = new URL(connectionString).hostname;
  if (!localHosts.has(host)) throw new Error(`Refusing to seed the default admin account into non-local database host ${host}`);
  const database = createDatabase(connectionString, "postgres-js");
  const now = new Date();
  await database.insert(user).values({ id: localAdmin.id, name: "Local admin", email: localAdmin.email, emailVerified: true, createdAt: now, updatedAt: now }).onConflictDoNothing();
  await database.insert(account).values({ id: `${localAdmin.id}-credential`, accountId: localAdmin.id, providerId: "credential", userId: localAdmin.id, password: await hashPassword(localAdmin.password), createdAt: now, updatedAt: now }).onConflictDoNothing();
  const held = new Set(await activePlatformRoles(database, localAdmin.id));
  const granted: string[] = [];
  for (const role of platformRoles.list()) {
    if (held.has(role.key)) continue;
    await grantPlatformRole(database, { userId: localAdmin.id, role: role.key }, { actor: { type: "system", id: "trestle-dev" }, reason: "local development default operator", environment: "local", correlationId: `seed:${crypto.randomUUID()}` });
    granted.push(role.key);
  }
  return { granted };
}
