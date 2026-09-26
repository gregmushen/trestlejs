import { applicationRoles, organizationRoles, platformRoles } from "@__TRESTLE_PROJECT_NAME__/authz";
import { account, activeApplicationRoles, activePlatformRoles, createDatabase, grantApplicationRoles, grantPlatformRole, member, organization, user } from "@__TRESTLE_PROJECT_NAME__/db";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";

export type DevAccountInput = Readonly<{
  email: string;
  name?: string;
  /** Required only when the account does not exist yet or to change its password. Never logged. */
  password?: string;
  organization?: Readonly<{ slug: string; name?: string; role?: string }>;
  applicationRoles?: readonly string[];
  platformRoles?: readonly string[];
}>;

export type DevAccountResult = Readonly<{
  userId: string;
  created: boolean;
  passwordSet: boolean;
  organizationId?: string;
  organizationCreated?: boolean;
  organizationRole?: string;
  applicationRolesGranted: string[];
  platformRolesGranted: string[];
}>;

const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class DevAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevAccountError";
  }
}

/**
 * Creates or finds a verified local development account and, optionally, its
 * organization membership, application roles (tenant authority), and platform
 * roles (operator authority). Idempotent: existing accounts, memberships, and
 * grants are kept, and nothing is removed. Refuses non-local databases.
 */
export async function ensureDevAccount(connectionString: string, input: DevAccountInput): Promise<DevAccountResult> {
  if ((process.env.TRESTLE_ENV ?? process.env.APP_ENV ?? "local") !== "local") throw new DevAccountError("development accounts are only created for local development");
  const host = new URL(connectionString).hostname;
  if (!localHosts.has(host)) throw new DevAccountError(`refusing to create a development account in non-local database host ${host}`);
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/u.test(email)) throw new DevAccountError("a valid email is required");
  const unknown = (roles: readonly string[] | undefined, catalog: { get(key: string): unknown }) => (roles ?? []).filter((role) => !catalog.get(role));
  const badApplication = unknown(input.applicationRoles, applicationRoles);
  if (badApplication.length) throw new DevAccountError(`unknown application roles: ${badApplication.join(", ")}`);
  const badPlatform = unknown(input.platformRoles, platformRoles);
  if (badPlatform.length) throw new DevAccountError(`unknown platform roles: ${badPlatform.join(", ")}`);
  const organizationRole = input.organization?.role ?? "owner";
  if (input.organization && !organizationRoles.get(organizationRole)) throw new DevAccountError(`unknown organization role ${organizationRole}`);
  if (input.applicationRoles?.length && !input.organization) throw new DevAccountError("application roles are granted within an organization; pass --organization");

  const database = createDatabase(connectionString, "postgres-js");
  const now = new Date();
  const [existing] = await database.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (!existing && !input.password) throw new DevAccountError(`${email} does not exist yet; supply a password on standard input to create it`);
  const userId = existing?.id ?? `dev-${crypto.randomUUID()}`;
  if (!existing) {
    await database.insert(user).values({ id: userId, name: input.name ?? email.split("@")[0]!, email, emailVerified: true, createdAt: now, updatedAt: now });
  } else {
    await database.update(user).set({ emailVerified: true, ...(input.name ? { name: input.name } : {}), updatedAt: now }).where(eq(user.id, userId));
  }
  if (input.password) {
    const hash = await hashPassword(input.password);
    const [credential] = await database.select({ id: account.id }).from(account).where(and(eq(account.userId, userId), eq(account.providerId, "credential"))).limit(1);
    if (credential) await database.update(account).set({ password: hash, updatedAt: now }).where(eq(account.id, credential.id));
    else await database.insert(account).values({ id: `${userId}-credential`, accountId: userId, providerId: "credential", userId, password: hash, createdAt: now, updatedAt: now });
  }

  let organizationId: string | undefined;
  let organizationCreated = false;
  if (input.organization) {
    const [found] = await database.select({ id: organization.id }).from(organization).where(eq(organization.slug, input.organization.slug)).limit(1);
    organizationId = found?.id ?? `dev-org-${crypto.randomUUID()}`;
    if (!found) {
      await database.insert(organization).values({ id: organizationId, name: input.organization.name ?? input.organization.slug, slug: input.organization.slug, createdAt: now });
      organizationCreated = true;
    }
    const [membership] = await database.select({ id: member.id }).from(member).where(and(eq(member.organizationId, organizationId), eq(member.userId, userId))).limit(1);
    if (!membership) await database.insert(member).values({ id: `dev-member-${crypto.randomUUID()}`, organizationId, userId, role: organizationRole, createdAt: now });
  }

  const heldApplication = organizationId ? new Set(await activeApplicationRoles(database, organizationId, userId)) : new Set<string>();
  const applicationRolesGranted = (input.applicationRoles ?? []).filter((role) => !heldApplication.has(role));
  if (organizationId && applicationRolesGranted.length) await grantApplicationRoles(database, { organizationId, userId, roles: applicationRolesGranted, grantedBy: "trestle-dev-account" });

  const heldPlatform = new Set(await activePlatformRoles(database, userId));
  const platformRolesGranted: string[] = [];
  for (const role of input.platformRoles ?? []) {
    if (heldPlatform.has(role)) continue;
    await grantPlatformRole(database, { userId, role }, { actor: { type: "system", id: "trestle-dev-account" }, reason: "local development account", environment: "local", correlationId: `dev-account:${crypto.randomUUID()}` });
    platformRolesGranted.push(role);
  }
  return {
    userId, created: !existing, passwordSet: Boolean(input.password),
    ...(organizationId ? { organizationId, organizationCreated, organizationRole } : {}),
    applicationRolesGranted, platformRolesGranted,
  };
}
