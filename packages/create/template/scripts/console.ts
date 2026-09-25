import repl from "node:repl";

import { eq } from "drizzle-orm";
import { createLogger, loggerSecretsFromEnvironment } from "../packages/context/src/index.js";
import { createDatabase, createTenantDatabase, organization, tenantRecord, type DatabaseDriver } from "../packages/db/src/index.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const environment = process.env.TRESTLE_ENV ?? "local";
const mode = process.env.TRESTLE_CONSOLE_MODE ?? "READ ONLY";
const requestedTenant = process.env.TRESTLE_CONSOLE_TENANT || undefined;
const operatorId = process.env.TRESTLE_CONSOLE_OPERATOR || "unknown";
const sessionId = crypto.randomUUID();
const driver = (process.env.DATABASE_DRIVER ?? "neon-serverless") as DatabaseDriver;
const databaseURL = required(mode === "PLATFORM ADMIN" ? "DATABASE_PLATFORM_URL" : "DATABASE_URL");
const resolver = createDatabase(databaseURL, driver);
const resolvedBySlug = requestedTenant ? await resolver.select({ id: organization.id, slug: organization.slug, name: organization.name }).from(organization).where(eq(organization.slug, requestedTenant)).limit(1) : [];
const resolvedById = requestedTenant && resolvedBySlug.length === 0 ? await resolver.select({ id: organization.id, slug: organization.slug, name: organization.name }).from(organization).where(eq(organization.id, requestedTenant)).limit(1) : [];
const resolvedTenant = resolvedBySlug[0] ?? resolvedById[0];
if (requestedTenant && !resolvedTenant) throw new Error(`Tenant ${requestedTenant} was not found`);
if (mode !== "PLATFORM ADMIN" && !resolvedTenant) throw new Error("Application console requires --tenant unless --platform-admin is used");

const log = createLogger({ eventSource: "console", consoleSessionId: sessionId, operatorId, environment, organizationId: resolvedTenant?.id }, undefined, { secretValues: loggerSecretsFromEnvironment(process.env) });
log.info("console.session.started", { mode });

const tenantDatabase = resolvedTenant ? createTenantDatabase(databaseURL, driver, resolvedTenant.id, { readOnly: mode === "READ ONLY" }) : undefined;
const records: { list: () => Promise<unknown>; create: (name: string) => Promise<unknown> } | undefined = resolvedTenant && tenantDatabase ? {
  list: async () => await tenantDatabase.select({ id: tenantRecord.id, name: tenantRecord.name, createdAt: tenantRecord.createdAt }).from(tenantRecord).orderBy(tenantRecord.createdAt),
  create: mode === "WRITE" ? async (name: string) => {
    if (!name.trim()) throw new Error("name is required");
    const [row] = await tenantDatabase.insert(tenantRecord).values({ organizationId: resolvedTenant.id, name: name.trim() }).returning();
    const created = row ? { id: row.id, name: row.name } : undefined;
    log.info("console.tenant_record.created", { resourceId: created?.id });
    return created;
  } : async (_name: string) => { throw new Error("Console is READ ONLY; reopen with --write"); },
} : undefined;

const platform = mode === "PLATFORM ADMIN" ? {
  organizations: async () => await resolver.select({ id: organization.id, slug: organization.slug, name: organization.name }).from(organization).orderBy(organization.slug),
} : undefined;

const server = repl.start({ prompt: `__TRESTLE_PROJECT_NAME__ [${environment}${resolvedTenant ? ` tenant=${resolvedTenant.slug}` : " platform"} ${mode}]> `, useGlobal: false, ignoreUndefined: true });
server.context.scope = Object.freeze({ environment, mode, tenant: resolvedTenant ?? null, operatorId, sessionId });
if (records) server.context.records = records;
if (platform) server.context.platform = platform;
server.context.help = () => ({ scope: "Resolved non-secret console scope", records: records ? "Tenant-bound record helpers" : undefined, platform: platform ? "Separately authorized platform helpers" : undefined });
server.on("exit", () => log.info("console.session.ended", { mode }));

console.log(`Available: scope, ${records ? "records, " : ""}${platform ? "platform, " : ""}help() — raw database handles and credential values are intentionally not exposed.`);
