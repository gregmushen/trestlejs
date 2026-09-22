import { createDatabase, member, organization, tenantRecord, user, type DatabaseDriver } from "../packages/db/src/index.js";
import { seedScenarios, type SeedScenarioName } from "./scenarios.js";

export async function applySeedScenario(name: SeedScenarioName, connectionString: string, driver: DatabaseDriver = "postgres-js"): Promise<void> {
  const scenario = seedScenarios[name];
  const database = createDatabase(connectionString, driver);
  await database.transaction(async (transaction) => {
    for (const value of scenario.users) await transaction.insert(user).values({ ...value, emailVerified: true }).onConflictDoUpdate({ target: user.id, set: { name: value.name, email: value.email, emailVerified: true, updatedAt: new Date("2026-01-01T00:00:00.000Z") } });
    for (const value of scenario.organizations) {
      await transaction.insert(organization).values({ id: value.id, name: value.name, slug: value.slug, createdAt: new Date("2026-01-01T00:00:00.000Z") }).onConflictDoUpdate({ target: organization.id, set: { name: value.name, slug: value.slug } });
      await transaction.insert(member).values({ id: `seed-member-${value.id}`, organizationId: value.id, userId: value.ownerId, role: "owner", createdAt: new Date("2026-01-01T00:00:00.000Z") }).onConflictDoUpdate({ target: member.id, set: { organizationId: value.id, userId: value.ownerId, role: "owner" } });
    }
    for (const value of scenario.records) await transaction.insert(tenantRecord).values(value).onConflictDoUpdate({ target: tenantRecord.id, set: { organizationId: value.organizationId, name: value.name } });
  });
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  if (process.env.APP_ENV === "production") throw new Error("production seeding is disabled");
  const name = (process.argv[2] ?? "default") as SeedScenarioName;
  if (!(name in seedScenarios)) throw new Error(`unknown seed scenario ${name}`);
  const connectionString = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  await applySeedScenario(name, connectionString, (process.env.DATABASE_DRIVER ?? "postgres-js") as DatabaseDriver);
  process.stdout.write(`Seeded ${name}\n`);
}
