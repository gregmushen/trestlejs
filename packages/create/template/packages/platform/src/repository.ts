import type { ApplicationEnvironment } from "@__TRESTLE_PROJECT_NAME__/authz";
import { effectiveEntitlementStatements, overrideFromRow, planVersionFromRow, resolveEffectiveEntitlements, features, type EffectiveEntitlement, type PlanVersion, type SubscriptionOverride } from "@__TRESTLE_PROJECT_NAME__/billing";
import { canonicalCurrency, canonicalLocale, canonicalTimeZone } from "@__TRESTLE_PROJECT_NAME__/regional";
import { createSqlRunner, platformConnectionString, type DatabaseDriver, type SqlRow, type SqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";
import { sql, type SQL } from "drizzle-orm";

import type { CapabilityStatus } from "./capabilities.js";

export type PlatformAudit = Readonly<{
  name: string;
  actorId: string;
  organizationId: string | null;
  targetType: string;
  targetId: string;
  reason: string;
  summary: Readonly<Record<string, unknown>>;
  environment: string;
  correlationId: string;
  now: Date;
}>;

const iso = (value: unknown): string | null => value === null || value === undefined ? null : (value instanceof Date ? value : new Date(String(value))).toISOString();
const json = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) : value ?? null;
const nullableText = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
const textArray = (values: readonly string[]) => sql`${`{${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`).join(",")}}`}::text[]`;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
const splitRoles = (value: unknown): string[] => String(value ?? "").split(",").map((role) => role.trim()).filter(Boolean).sort();
const like = (q: string | undefined) => `%${(q ?? "").replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;

/**
 * Cross-tenant platform repository. It connects only through the audited
 * trestle_platform role, whose grants exclude credentials, session tokens,
 * API-key verifiers, and application-role writes.
 */
export class PostgresPlatformRepository {
  private readonly db: SqlRunner;
  constructor(connectionString: string, driver?: DatabaseDriver) {
    this.db = createSqlRunner(platformConnectionString(connectionString), driver);
  }

  /** The platform-role connection, for shared loaders such as the access catalog. */
  get runner(): SqlRunner { return this.db; }

  /** Every platform mutation commits with its audit record and outbox event. */
  async mutate(statements: readonly SQL[], audit: PlatformAudit, actorType: "user" | "system" = "user"): Promise<void> {
    const eventId = crypto.randomUUID();
    await this.db.atomic([
      ...statements,
      sql`insert into audit_event (name, schema_version, actor_type, actor_id, organization_id, target_type, target_id, reason, summary, outcome, environment, correlation_id, occurred_at)
          values (${audit.name}, 1, ${actorType}, ${audit.actorId}, ${audit.organizationId}, ${audit.targetType}, ${audit.targetId}, ${audit.reason}, ${JSON.stringify(audit.summary)}::text::jsonb, 'succeeded', ${audit.environment}, ${audit.correlationId}, ${audit.now})`,
      sql`insert into outbox_message (id, event_name, schema_version, occurred_at, resource_type, resource_id, correlation_id, idempotency_key, payload, available_at)
          values (${eventId}, ${audit.name}, 1, ${audit.now}, ${audit.targetType}, ${audit.targetId}, ${audit.correlationId}, ${`${audit.name}:${eventId}`}, ${JSON.stringify({ organizationId: audit.organizationId, ...audit.summary })}::text::jsonb, ${audit.now})`,
    ]);
  }

  /** How the operator's current session was authenticated, recorded by the Better Auth hook. */
  async assurance(sessionId: string) {
    const [row] = await this.db.query(sql`select session_id, level, method, verified_at from authentication_assurance where session_id = ${sessionId}`);
    return row ? { sessionId: String(row.session_id), level: String(row.level) as "password" | "mfa" | "phishing_resistant", method: String(row.method) as "password" | "totp" | "otp" | "backup_code" | "passkey", verifiedAt: new Date(iso(row.verified_at)!) } : null;
  }

  /** Which factors a user has enrolled: names and dates only, never secrets or credential material. */
  async securityFactors(userId: string) {
    const [twoFactor, passkeys] = await Promise.all([
      this.db.query(sql`select verified from two_factor where user_id = ${userId}`),
      this.db.query(sql`select id, name, device_type, backed_up, created_at from passkey where user_id = ${userId} order by created_at`),
    ]);
    return { twoFactor: twoFactor.some((row) => row.verified !== false), passkeys: passkeys.map((row) => ({ id: String(row.id), name: row.name ? String(row.name) : "Passkey", deviceType: String(row.device_type), backedUp: row.backed_up === true, createdAt: iso(row.created_at) })) };
  }

  async activePlatformRoles(userId: string): Promise<string[]> {
    return (await this.db.query(sql`select role from platform_role_assignment where user_id = ${userId} and revoked_at is null order by role`)).map((row) => String(row.role));
  }

  async counts() {
    const [row] = await this.db.query(sql`select (select count(*) from organization) as organizations, (select count(*) from "user") as users, (select count(*) from outbox_message where status = 'dead') as dead`);
    return { organizations: Number(row?.organizations ?? 0), users: Number(row?.users ?? 0), deadLetters: Number(row?.dead ?? 0) };
  }

  /**
   * Exceptions for the overview (§3.2): things an operator should act on, each
   * with the affected resource. Each probe is independent, so one failing
   * query cannot hide the others; a failed probe is itself reported.
   */
  async overviewExceptions(now: Date) {
    const probe = async <T>(name: string, work: () => Promise<T[]>): Promise<Array<T | { kind: "probe_failed"; severity: "warning"; title: string; detail: string; href: string }>> => {
      try { return await work(); } catch { return [{ kind: "probe_failed" as const, severity: "warning" as const, title: `Could not check ${name}`, detail: "The query failed; see Health for database status.", href: "/system/health" }]; }
    };
    type Item = { kind: string; severity: "critical" | "warning"; title: string; detail: string; href: string; count?: number };
    const day = new Date(now.getTime() - 24 * 3_600_000);
    const groups = await Promise.all([
      probe<Item>("dead letters", async () => {
        const [row] = await this.db.query(sql`select count(*) as total, min(event_name) as sample from outbox_message where status = 'dead'`);
        const total = Number(row?.total ?? 0);
        return total ? [{ kind: "dead_letters", severity: "critical", title: `${total} dead-lettered event${total === 1 ? "" : "s"}`, detail: `Delivery stopped after retries${row?.sample ? `, e.g. ${String(row.sample)}` : ""}. Redrive after fixing the cause.`, href: "/operations/async", count: total }] : [];
      }),
      probe<Item>("webhooks", async () => (await this.db.query(sql`select e.id, e.name, o.name as organization_name, e.state, e.consecutive_failures, e.disabled_reason
          from webhook_endpoint e left join organization o on o.id = e.organization_id
          where e.deleted_at is null and ((e.state <> 'disabled' and e.consecutive_failures >= 5) or (e.state = 'disabled' and e.disabled_by like 'system%'))
          order by e.consecutive_failures desc limit 5`)).map((row): Item => ({
        kind: "webhook_failing", severity: row.state === "disabled" ? "critical" : "warning", title: `Webhook ${String(row.name)} ${row.state === "disabled" ? "was disabled" : "is failing"}`,
        detail: `${row.organization_name ? String(row.organization_name) : "Unknown organization"} · ${Number(row.consecutive_failures)} consecutive failures${row.disabled_reason ? ` · ${String(row.disabled_reason)}` : ""}`, href: `/integrations/webhooks?selected=${encodeURIComponent(String(row.id))}`,
      }))),
      probe<Item>("notifications", async () => {
        const [row] = await this.db.query(sql`select count(*) as total from notification_delivery where status = 'failed' and created_at > ${day}`);
        const total = Number(row?.total ?? 0);
        return total ? [{ kind: "notification_failures", severity: "warning", title: `${total} notification deliver${total === 1 ? "y" : "ies"} failed in 24 hours`, detail: "Retry eligible deliveries or check the email route.", href: "/communications/notifications?tab=deliveries&status=failed", count: total }] : [];
      }),
      probe<Item>("email", async () => {
        const [row] = await this.db.query(sql`select count(*) as total from email_delivery d where d.created_at > ${day} and (d.status = 'failed' or exists (select 1 from email_delivery_event e where e.email_delivery_id = d.id and e.status in ('bounced', 'complained', 'failed')))`);
        const total = Number(row?.total ?? 0);
        return total ? [{ kind: "email_failures", severity: "warning", title: `${total} email${total === 1 ? "" : "s"} failed or bounced in 24 hours`, detail: "Provider-neutral status; open Email delivery for templates and correlation.", href: "/communications/email?status=failed", count: total }] : [];
      }),
      probe<Item>("reconciliation", async () => (await this.db.query(sql`select distinct on (r.organization_id) r.organization_id, o.name as organization_name, r.outcome, r.created_at
          from provider_reconciliation r left join organization o on o.id = r.organization_id order by r.organization_id, r.created_at desc`))
        .filter((row) => String(row.outcome) !== "in_sync").slice(0, 5).map((row): Item => ({
          kind: "reconciliation_drift", severity: "warning", title: `Billing drift for ${row.organization_name ? String(row.organization_name) : String(row.organization_id)}`,
          detail: `Last reconciliation: ${String(row.outcome).replaceAll("_", " ")}`, href: `/subscriptions?selected=${encodeURIComponent(String(row.organization_id))}&tab=reconciliation`,
        }))),
      probe<Item>("subscriptions", async () => (await this.db.query(sql`select s.organization_id, o.name as organization_name from organization_subscription s left join organization o on o.id = s.organization_id where s.status = 'past_due' limit 5`)).map((row): Item => ({
        kind: "past_due", severity: "warning", title: `${row.organization_name ? String(row.organization_name) : String(row.organization_id)} is past due`, detail: "Access continues during dunning; check the provider.", href: `/subscriptions?selected=${encodeURIComponent(String(row.organization_id))}`,
      }))),
      probe<Item>("support sessions", async () => (await this.db.query(sql`select s.id, s.organization_id, o.name as organization_name, s.expires_at from support_session s left join organization o on o.id = s.organization_id where s.ended_at is null and s.expires_at > ${now} and s.expires_at < ${new Date(now.getTime() + 15 * 60_000)} limit 5`)).map((row): Item => ({
        kind: "support_expiring", severity: "warning", title: "A support session expires soon", detail: `${row.organization_name ? String(row.organization_name) : String(row.organization_id)} · until ${iso(row.expires_at)}`, href: `/support/sessions?selected=${encodeURIComponent(String(row.id))}`,
      }))),
      probe<Item>("API keys", async () => {
        const rows = await this.db.query(sql`select k.id, k.display_prefix, o.name as organization_name, k.organization_id, k.expires_at from api_key k left join organization o on o.id = k.organization_id
          where k.revoked_at is null and k.expires_at is not null and k.expires_at > ${now} and k.expires_at < ${new Date(now.getTime() + 7 * 24 * 3_600_000)} order by k.expires_at limit 5`);
        return rows.map((row): Item => ({ kind: "credential_expiring", severity: "warning", title: `API key ${String(row.display_prefix).slice(0, 12)}… expires within 7 days`, detail: `${row.organization_name ? String(row.organization_name) : String(row.organization_id)} · expires ${iso(row.expires_at)}`, href: `/access/api-keys?selected=${encodeURIComponent(String(row.id))}` }));
      }),
      probe<Item>("regional settings", async () => {
        // Stored values are validated on write; a runtime whose zone or currency data changed can still leave legacy values behind.
        const rows = await this.db.query(sql`select r.organization_id, o.name as organization_name, r.language, r.locale, r.time_zone, r.currency
          from organization_regional_settings r left join organization o on o.id = r.organization_id order by r.organization_id limit 1000`);
        const invalid = rows.filter((row) => (row.time_zone && !canonicalTimeZone(row.time_zone)) || (row.locale && !canonicalLocale(row.locale)) || (row.currency && !canonicalCurrency(row.currency)));
        return invalid.length ? [{ kind: "regional_invalid", severity: "warning", title: `${invalid.length} organization${invalid.length === 1 ? " has" : "s have"} invalid regional configuration`, detail: `e.g. ${String(invalid[0]!.organization_name ?? invalid[0]!.organization_id)}: a legacy time zone, locale, or currency is no longer recognized`, href: `/organizations/${String(invalid[0]!.organization_id)}?tab=regional`, count: invalid.length }] : [];
      }),
    ]);
    return groups.flat() as Item[];
  }

  async migrationsApplied(): Promise<number | null> {
    try { return Number((await this.db.query(sql`select count(*) as applied from drizzle.__drizzle_migrations`))[0]?.applied ?? 0); } catch { return null; }
  }

  async capabilityStatuses(environment: string): Promise<Array<CapabilityStatus & { reportedAt: string }>> {
    return (await this.db.query(sql`select * from capability_status where environment = ${environment} order by capability_id`)).map((row) => ({
      id: String(row.capability_id) as CapabilityStatus["id"], label: String(row.label), state: String(row.state) as CapabilityStatus["state"], healthy: row.healthy === true,
      ...(row.mode ? { mode: String(row.mode) } : {}),
      ...(row.message ? { message: String(row.message) } : {}), ...(row.repair ? { repair: String(row.repair) } : {}), reportedAt: iso(row.reported_at)!,
    }));
  }

  async searchOrganizations(q?: string) {
    return (await this.db.query(sql`select o.id, o.name, o.slug, o.created_at, (select count(*) from member m where m.organization_id = o.id) as members, s.plan_version, s.plan, s.status
      from organization o left join organization_subscription s on s.organization_id = o.id
      where o.name ilike ${like(q)} or o.slug ilike ${like(q)} or o.id = ${q ?? ""} order by o.created_at desc limit 100`))
      .map((row) => ({ id: String(row.id), name: String(row.name), slug: String(row.slug), createdAt: iso(row.created_at)!, members: Number(row.members), ...(row.plan ? { plan: String(row.plan_version ?? row.plan) } : {}), ...(row.status ? { status: String(row.status) } : {}) }));
  }

  async organization(id: string) {
    const [organization] = await this.db.query(sql`select id, name, slug, created_at from organization where id = ${id}`);
    if (!organization) return null;
    const members = await this.db.query(sql`select m.id, m.user_id, m.role, u.name, u.email,
        coalesce((select array_agg(a.role order by a.role) from application_role_assignment a where a.organization_id = m.organization_id and a.user_id = m.user_id and a.revoked_at is null), '{}') as application_roles
      from member m join "user" u on u.id = m.user_id where m.organization_id = ${id} order by lower(u.name)`);
    return {
      organization: { id: String(organization.id), name: String(organization.name), slug: String(organization.slug), createdAt: iso(organization.created_at)!, members: members.length },
      members: members.map((row) => ({ memberId: String(row.id), userId: String(row.user_id), name: String(row.name), email: String(row.email), organizationRoles: splitRoles(row.role), applicationRoles: strings(row.application_roles) })),
    };
  }

  /** Stored organization regional defaults (read-only; recovery writes go through the tenant role). */
  async organizationRegional(organizationId: string) {
    const [row] = await this.db.query(sql`select language, locale, time_zone, currency from organization_regional_settings where organization_id = ${organizationId}`);
    return row ? { language: nullableText(row.language), locale: nullableText(row.locale), timeZone: nullableText(row.time_zone), currency: nullableText(row.currency) } : null;
  }

  /** A user's own regional preferences, for explaining their effective context. */
  async userRegional(userId: string) {
    const [row] = await this.db.query(sql`select language, locale, time_zone from user_regional_preference where user_id = ${userId}`);
    return row ? { language: nullableText(row.language), locale: nullableText(row.locale), timeZone: nullableText(row.time_zone) } : null;
  }

  async searchUsers(q?: string) {
    const users = await this.db.query(sql`select id, name, email, email_verified, suspended_at, created_at from "user" where name ilike ${like(q)} or email ilike ${like(q)} or id = ${q ?? ""} order by created_at desc limit 100`);
    const ids = users.map((row) => String(row.id));
    if (ids.length === 0) return [];
    const idArray = sql`${`{${ids.map((value) => `"${value}"`).join(",")}}`}::text[]`;
    const [memberships, applications, platform] = await Promise.all([
      this.db.query(sql`select m.user_id, m.organization_id, o.name, m.role from member m join organization o on o.id = m.organization_id where m.user_id = any(${idArray})`),
      this.db.query(sql`select user_id, organization_id, role from application_role_assignment where user_id = any(${idArray}) and revoked_at is null`),
      this.db.query(sql`select user_id, role from platform_role_assignment where user_id = any(${idArray}) and revoked_at is null`),
    ]);
    return users.map((row) => ({
      id: String(row.id), name: String(row.name), email: String(row.email), emailVerified: row.email_verified === true, banned: Boolean(row.suspended_at), createdAt: iso(row.created_at)!,
      memberships: memberships.filter((membership) => membership.user_id === row.id).map((membership) => ({
        organizationId: String(membership.organization_id), organizationName: String(membership.name), organizationRoles: splitRoles(membership.role),
        applicationRoles: applications.filter((assignment) => assignment.user_id === row.id && assignment.organization_id === membership.organization_id).map((assignment) => String(assignment.role)).sort(),
      })),
      platformRoles: platform.filter((assignment) => assignment.user_id === row.id).map((assignment) => String(assignment.role)).sort(),
    }));
  }

  async userExists(id: string): Promise<boolean> {
    return (await this.db.query(sql`select 1 from "user" where id = ${id}`)).length === 1;
  }

  suspendUser(id: string, reason: string): SQL[] {
    return [sql`update "user" set suspended_at = now(), suspension_reason = ${reason} where id = ${id}`, sql`delete from session where user_id = ${id}`];
  }

  restoreUser(id: string): SQL[] {
    return [sql`update "user" set suspended_at = null, suspension_reason = null where id = ${id}`];
  }

  revokeSessions(id: string): SQL[] {
    return [sql`delete from session where user_id = ${id}`];
  }

  async platformRoleAssignments(includeRevoked: boolean) {
    return (await this.db.query(includeRevoked
      ? sql`select a.*, u.email, u.name from platform_role_assignment a left join "user" u on u.id = a.user_id order by a.granted_at desc limit 500`
      : sql`select a.*, u.email, u.name from platform_role_assignment a left join "user" u on u.id = a.user_id where a.revoked_at is null order by a.granted_at desc`))
      .map((row) => ({ id: String(row.id), userId: String(row.user_id), ...(row.email ? { email: String(row.email), name: String(row.name) } : {}), role: String(row.role), grantedAt: iso(row.granted_at)!, grantedBy: String(row.granted_by), reason: String(row.reason), revokedAt: iso(row.revoked_at), revokedBy: row.revoked_by ? String(row.revoked_by) : null }));
  }

  assignPlatformRole(userId: string, role: string, grantedBy: string, reason: string): SQL[] {
    return [sql`insert into platform_role_assignment (user_id, role, granted_by, reason) values (${userId}, ${role}, ${grantedBy}, ${reason}) on conflict do nothing`];
  }

  revokePlatformRole(userId: string, role: string, revokedBy: string, reason: string): SQL[] {
    return [sql`update platform_role_assignment set revoked_at = now(), revoked_by = ${revokedBy}, revocation_reason = ${reason} where user_id = ${userId} and role = ${role} and revoked_at is null`];
  }

  /** The operator's open support session, including one that has just expired (the caller ends it). */
  async activeSupportSession(operatorId: string) {
    const [row] = await this.db.query(sql`select s.*, o.name as organization_name from support_session s join organization o on o.id = s.organization_id where s.operator_id = ${operatorId} and s.ended_at is null limit 1`);
    return row ? supportSession(row) : null;
  }

  startSupportSession(session: Readonly<{ id: string; operatorId: string; organizationId: string; reason: string; ticket: string | null; profile: string; permissions: Readonly<{ organization: readonly string[]; application: readonly string[]; denied: readonly string[] }>; expiresAt: Date }>): SQL[] {
    return [
      // Switching tenants ends the current session; a new one needs its own reason and preview.
      sql`update support_session set ended_at = now(), end_reason = 'replaced', ended_by = ${session.operatorId} where operator_id = ${session.operatorId} and ended_at is null`,
      sql`insert into support_session (id, operator_id, organization_id, reason, ticket, profile, permissions, expires_at) values (${session.id}, ${session.operatorId}, ${session.organizationId}, ${session.reason}, ${session.ticket}, ${session.profile}, ${JSON.stringify(session.permissions)}::text::jsonb, ${session.expiresAt})`,
    ];
  }

  endSupportSession(id: string, reason: "exited" | "expired" | "revoked", endedBy: string, revocationReason: string | null = null): SQL[] {
    return [sql`update support_session set ended_at = now(), end_reason = ${reason}, ended_by = ${endedBy}, revocation_reason = ${revocationReason} where id = ${id} and ended_at is null`];
  }

  async supportSessions(filter: Readonly<{ active?: boolean; organizationId?: string }>) {
    const clauses: SQL[] = [sql`true`];
    if (filter.active) clauses.push(sql`s.ended_at is null and s.expires_at > now()`);
    if (filter.organizationId) clauses.push(sql`s.organization_id = ${filter.organizationId}`);
    return (await this.db.query(sql`select s.*, o.name as organization_name, u.email as operator_email, u.name as operator_name,
        (select count(*) from audit_event a where a.support_session_id = s.id) as activity
      from support_session s left join organization o on o.id = s.organization_id left join "user" u on u.id = s.operator_id
      where ${sql.join(clauses, sql` and `)} order by s.started_at desc limit 200`))
      .map((row) => ({ ...supportSession(row), operator: { id: String(row.operator_id), email: String(row.operator_email ?? ""), name: String(row.operator_name ?? "") }, activity: Number(row.activity) }));
  }

  async supportSessionDetail(id: string) {
    const [row] = await this.db.query(sql`select s.*, o.name as organization_name, u.email as operator_email, u.name as operator_name from support_session s left join organization o on o.id = s.organization_id left join "user" u on u.id = s.operator_id where s.id = ${id}`);
    if (!row) return null;
    const activity = await this.db.query(sql`select id, occurred_at, name, actor_id, target_type, target_id, reason, outcome, correlation_id from audit_event
      where support_session_id = ${id} or (target_type = 'support_session' and target_id = ${id}) order by occurred_at limit 500`);
    return {
      session: { ...supportSession(row), operator: { id: String(row.operator_id), email: String(row.operator_email ?? ""), name: String(row.operator_name ?? "") } },
      activity: activity.map((event) => ({ id: String(event.id), name: String(event.name), occurredAt: iso(event.occurred_at)!, actor: String(event.actor_id), target: `${String(event.target_type)}:${String(event.target_id)}`, ...(event.reason ? { reason: String(event.reason) } : {}), outcome: String(event.outcome), correlationId: String(event.correlation_id) })),
    };
  }

  async planVersions(): Promise<PlanVersion[]> {
    return (await this.db.query(sql`select * from plan_version order by plan, version`)).map(planVersionFromRow);
  }

  async planVersion(plan: string, version: number): Promise<PlanVersion | null> {
    const [row] = await this.db.query(sql`select * from plan_version where plan = ${plan} and version = ${version}`);
    return row ? planVersionFromRow(row) : null;
  }

  async subscriptionsOnVersion(ref: string): Promise<number> {
    return Number((await this.db.query(sql`select count(*) as total from organization_subscription where plan_version = ${ref}`))[0]?.total ?? 0);
  }

  insertPlanVersion(version: PlanVersion, createdBy: string): SQL[] {
    return [sql`insert into plan_version (plan, version, name, state, entitlements, created_by) values (${version.plan}, ${version.version}, ${version.name}, ${version.state}, ${JSON.stringify(version.entitlements)}::text::jsonb, ${createdBy})`];
  }

  /** Drafts are the only mutable plan versions; the WHERE clause enforces it again in SQL. */
  updateDraft(version: PlanVersion): SQL[] {
    return [sql`update plan_version set name = ${version.name}, entitlements = ${JSON.stringify(version.entitlements)}::text::jsonb where plan = ${version.plan} and version = ${version.version} and state = 'draft'`];
  }

  transitionPlanVersion(version: PlanVersion, from: PlanVersion["state"]): SQL[] {
    return [sql`update plan_version set state = ${version.state}, activated_at = ${version.activatedAt ?? null}, grandfathered_at = ${version.grandfatheredAt ?? null}, retired_at = ${version.retiredAt ?? null}
      where plan = ${version.plan} and version = ${version.version} and state = ${from}`];
  }

  async subscriptions(q?: string) {
    return (await this.db.query(sql`select s.*, o.name as organization_name from organization_subscription s left join organization o on o.id = s.organization_id
      where o.name ilike ${like(q)} or s.organization_id = ${q ?? ""} or s.plan ilike ${like(q)} or coalesce(s.provider_subscription_id, '') = ${q ?? ""} order by s.updated_at desc limit 100`))
      .map((row) => ({
        organizationId: String(row.organization_id), ...(row.organization_name ? { organizationName: String(row.organization_name) } : {}), plan: String(row.plan), ...(row.plan_version ? { planVersion: String(row.plan_version) } : {}),
        status: String(row.status), provider: String(row.provider), ...(row.provider_subscription_id ? { providerSubscriptionId: String(row.provider_subscription_id) } : {}),
        ...(row.current_period_end ? { currentPeriodEnd: iso(row.current_period_end)! } : {}), cancelAtPeriodEnd: row.cancel_at_period_end === true, updatedAt: iso(row.updated_at)!,
      }));
  }

  async subscriptionState(organizationId: string) {
    const [row] = await this.db.query(sql`select * from organization_subscription where organization_id = ${organizationId}`);
    const overrides = (await this.db.query(sql`select * from subscription_override where organization_id = ${organizationId} order by effective_at`)).map(overrideFromRow);
    if (!row) return { row: null, planVersion: null, overrides };
    const [plan, version] = String(row.plan_version ?? `${String(row.plan)}@1`).split("@");
    return { row, planVersion: await this.planVersion(plan!, Number(version)), overrides };
  }

  async scheduledChanges(organizationId: string) {
    return (await this.db.query(sql`select * from subscription_change where organization_id = ${organizationId} order by effective_at desc`)).map((row) => ({ id: String(row.id), toPlanVersion: String(row.to_plan_version), effectiveAt: iso(row.effective_at)!, reason: String(row.reason), author: String(row.author), status: row.applied_at ? "applied" : row.cancelled_at ? "cancelled" : "scheduled" }));
  }

  /** Explicit provider mappings (§4.2) for one environment; verification holds only what the provider reported. */
  async billingMappings(filter: Readonly<{ environment: string; provider?: string; plan?: string; id?: string }>) {
    return (await this.db.query(sql`select * from billing_provider_mapping where environment = ${filter.environment}
        and (${filter.provider ?? null}::text is null or provider = ${filter.provider ?? null}) and (${filter.plan ?? null}::text is null or plan = ${filter.plan ?? null}) and (${filter.id ?? null}::text is null or id::text = ${filter.id ?? null})
        order by plan, kind desc, plan_version nulls first, offer nulls first`)).map((row) => ({
      id: String(row.id), environment: String(row.environment), provider: String(row.provider), kind: String(row.kind) as "product" | "price", plan: String(row.plan),
      planVersion: row.plan_version === null || row.plan_version === undefined ? null : Number(row.plan_version), offer: row.offer ? String(row.offer) : null, externalId: String(row.external_id),
      verifiedAt: iso(row.verified_at), verification: json(row.verification) as Record<string, unknown> | null, createdBy: String(row.created_by), createdAt: iso(row.created_at)!,
    }));
  }

  insertBillingMapping(input: { environment: string; provider: string; kind: "product" | "price"; plan: string; planVersion: number | null; offer: string | null; externalId: string; verification: Record<string, unknown> | null }, by: string): SQL[] {
    return [sql`insert into billing_provider_mapping (environment, provider, kind, plan, plan_version, offer, external_id, verified_at, verification, created_by)
      values (${input.environment}, ${input.provider}, ${input.kind}, ${input.plan}, ${input.planVersion}, ${input.offer}, ${input.externalId}, ${input.verification?.state === "verified" ? sql`now()` : null}, ${input.verification ? JSON.stringify(input.verification) : null}::text::jsonb, ${by})`];
  }

  recordBillingMappingVerification(id: string, verification: Record<string, unknown>): SQL[] {
    return [sql`update billing_provider_mapping set verification = ${JSON.stringify(verification)}::text::jsonb, verified_at = ${verification.state === "verified" ? sql`now()` : null} where id::text = ${id}`];
  }

  deleteBillingMapping(id: string): SQL[] {
    return [sql`delete from billing_provider_mapping where id::text = ${id}`];
  }

  async subscriptionLines(organizationId: string) {
    return (await this.db.query(sql`select * from subscription_line where organization_id = ${organizationId} order by created_at`)).map((row) => ({
      id: String(row.id), planVersion: String(row.plan_version), offer: row.offer ? String(row.offer) : null, quantity: Number(row.quantity),
      providerItemId: row.provider_item_id ? String(row.provider_item_id) : null, providerPriceId: row.provider_price_id ? String(row.provider_price_id) : null, updatedAt: iso(row.updated_at)!,
    }));
  }

  async subscriptionProviderIds(organizationId: string) {
    const [row] = await this.db.query(sql`select provider, provider_customer_id, provider_subscription_id from organization_subscription where organization_id = ${organizationId}`);
    return row ? { provider: String(row.provider), customerId: row.provider_customer_id ? String(row.provider_customer_id) : null, subscriptionId: row.provider_subscription_id ? String(row.provider_subscription_id) : null } : null;
  }

  /** Authentication policy versions (§10), newest first. */
  async authPolicyVersions() {
    return (await this.db.query(sql`select * from auth_policy_version order by version desc limit 100`)).map((row) => ({
      version: Number(row.version), state: String(row.state) as "draft" | "active" | "superseded" | "discarded", policy: json(row.policy) as Record<string, unknown>,
      basedOn: row.based_on === null || row.based_on === undefined ? null : Number(row.based_on), createdBy: String(row.created_by), createdAt: iso(row.created_at)!,
      activatedBy: row.activated_by ? String(row.activated_by) : null, activatedAt: iso(row.activated_at), reason: row.reason ? String(row.reason) : null,
    }));
  }

  insertAuthPolicyVersion(input: { version: number; state: "draft" | "active"; policy: unknown; basedOn: number | null; reason?: string }, by: string): SQL[] {
    return [
      ...(input.state === "active" ? [sql`update auth_policy_version set state = 'superseded' where state = 'active'`] : []),
      sql`insert into auth_policy_version (version, state, policy, based_on, created_by, activated_by, activated_at, reason)
        values (${input.version}, ${input.state}, ${JSON.stringify(input.policy)}::text::jsonb, ${input.basedOn}, ${by}, ${input.state === "active" ? by : null}, ${input.state === "active" ? sql`now()` : null}, ${input.reason ?? null})`,
    ];
  }

  updateAuthPolicyDraft(version: number, policy: unknown): SQL[] {
    return [sql`update auth_policy_version set policy = ${JSON.stringify(policy)}::text::jsonb where version = ${version} and state = 'draft'`];
  }

  discardAuthPolicyDraft(version: number): SQL[] {
    return [sql`update auth_policy_version set state = 'discarded' where version = ${version} and state = 'draft'`];
  }

  /** The active version is superseded in the same transaction; a partial unique index keeps one active. */
  activateAuthPolicyDraft(version: number, by: string, reason: string): SQL[] {
    return [
      sql`update auth_policy_version set state = 'superseded' where state = 'active'`,
      sql`update auth_policy_version set state = 'active', activated_by = ${by}, activated_at = now(), reason = ${reason} where version = ${version} and state = 'draft'`,
    ];
  }

  /**
   * Platform administrators who must keep a way in: active assignments of roles
   * that can manage authentication, on unsuspended accounts, with their factors.
   * Counts and flags only; never credential material.
   */
  async platformAdminFactors(roles: readonly string[]) {
    return (await this.db.query(sql`select u.id,
        (select count(*) from passkey p where p.user_id = u.id) as passkeys,
        exists (select 1 from two_factor t where t.user_id = u.id and t.verified is not false) as two_factor
      from "user" u where u.suspended_at is null and u.id in (select user_id from platform_role_assignment where revoked_at is null and role in (${sql.join(roles.map((role) => sql`${role}`), sql`, `)}))`))
      .map((row) => ({ userId: String(row.id), passkeys: Number(row.passkeys), twoFactor: row.two_factor === true }));
  }

  async reconciliations(organizationId: string) {
    return (await this.db.query(sql`select * from provider_reconciliation where organization_id = ${organizationId} order by created_at desc limit 20`)).map((row) => ({ id: String(row.id), organizationId, outcome: String(row.outcome), differences: (typeof row.differences === "string" ? JSON.parse(row.differences) : row.differences) as never, ranAt: iso(row.created_at)!, actor: String(row.actor) }));
  }

  async effectiveEntitlements(organizationId: string): Promise<EffectiveEntitlement[]> {
    return (await this.db.query(sql`select * from organization_entitlement where organization_id = ${organizationId} order by entitlement`)).map((row) => ({
      code: String(row.entitlement), enabled: row.enabled !== false, values: (typeof row.values === "string" ? JSON.parse(row.values) : row.values ?? {}) as EffectiveEntitlement["values"], source: row.source === "subscription_override" ? "subscription_override" : "plan",
      ...(row.inherited_from ? { inheritedFrom: String(row.inherited_from) } : {}), ...(row.override_id ? { overrideId: String(row.override_id) } : {}), effectiveAt: iso(row.effective_at)!, ...(row.expires_at ? { expiresAt: iso(row.expires_at)! } : {}),
    }));
  }

  async usage(organizationId: string) {
    return (await this.db.query(sql`select feature_code, period_start, period_end, quantity from usage_aggregate where organization_id = ${organizationId} and period_end > now()`)).map((row) => ({ code: String(row.feature_code), start: new Date(iso(row.period_start)!), end: new Date(iso(row.period_end)!), quantity: Number(row.quantity) }));
  }

  /** Current-period usage rows with what the metering provider accepted and last reported. */
  async usageRows(organizationId: string) {
    return await this.db.query(sql`select feature_code, period_start, period_end, quantity, reported_quantity, provider, provider_quantity, provider_balance, provider_has_access, provider_observed_at
      from usage_aggregate where organization_id = ${organizationId} and period_end > now() order by feature_code`);
  }

  /** Recomputes the effective projection from the recorded plan version and this subscription's overrides. */
  async recomputeStatements(organizationId: string, now: Date, pendingOverrides?: readonly SubscriptionOverride[]): Promise<SQL[]> {
    const state = await this.subscriptionState(organizationId);
    if (!state.row) return [];
    const effective = resolveEffectiveEntitlements(features, { status: String(state.row.status) as never, planVersion: state.planVersion, ...(state.row.started_at ? { startedAt: new Date(iso(state.row.started_at)!) } : {}) }, pendingOverrides ?? state.overrides, now);
    return effectiveEntitlementStatements(organizationId, effective);
  }

  insertOverride(override: SubscriptionOverride): SQL[] {
    return [sql`insert into subscription_override (id, organization_id, code, enabled, values, reason, author, effective_at, expires_at) values (${override.id}, ${override.organizationId}, ${override.code}, ${override.enabled}, ${JSON.stringify(override.values)}::text::jsonb, ${override.reason}, ${override.author}, ${override.effectiveAt}, ${override.expiresAt ?? null})`];
  }

  removeOverride(organizationId: string, id: string, removedBy: string, reason: string): SQL[] {
    return [sql`update subscription_override set removed_at = now(), removed_by = ${removedBy}, removal_reason = ${reason} where organization_id = ${organizationId} and id = ${id} and removed_at is null`];
  }

  async dueChanges(now: Date) {
    return (await this.db.query(sql`select id, organization_id, to_plan_version from subscription_change where applied_at is null and cancelled_at is null and effective_at <= ${now} order by effective_at limit 100`))
      .map((row) => ({ id: String(row.id), organizationId: String(row.organization_id), toPlanVersion: String(row.to_plan_version) }));
  }

  /** Moves the subscription to the scheduled version and recomputes its projection in one transaction. */
  async applyChangeStatements(change: { id: string; organizationId: string; toPlanVersion: string }, now: Date): Promise<SQL[]> {
    const [plan, version] = change.toPlanVersion.split("@");
    const target = await this.planVersion(plan!, Number(version));
    if (!target) return [sql`update subscription_change set cancelled_at = ${now} where id = ${change.id} and applied_at is null`];
    const state = await this.subscriptionState(change.organizationId);
    if (!state.row) return [sql`update subscription_change set cancelled_at = ${now} where id = ${change.id} and applied_at is null`];
    const effective = resolveEffectiveEntitlements(features, { status: String(state.row.status) as never, planVersion: target, startedAt: now }, state.overrides, now);
    return [
      sql`update organization_subscription set plan = ${target.plan}, plan_version = ${change.toPlanVersion}, updated_at = now() where organization_id = ${change.organizationId}`,
      ...effectiveEntitlementStatements(change.organizationId, effective),
      sql`update subscription_change set applied_at = ${now} where id = ${change.id} and applied_at is null`,
    ];
  }

  scheduleChange(organizationId: string, id: string, toPlanVersion: string, effectiveAt: Date, reason: string, author: string): SQL[] {
    return [sql`insert into subscription_change (id, organization_id, to_plan_version, effective_at, reason, author) values (${id}, ${organizationId}, ${toPlanVersion}, ${effectiveAt}, ${reason}, ${author})`];
  }

  recordReconciliation(organizationId: string, provider: string, outcome: string, differences: unknown, actor: string, reason: string): SQL[] {
    return [sql`insert into provider_reconciliation (organization_id, provider, outcome, differences, actor, reason) values (${organizationId}, ${provider}, ${outcome}, ${JSON.stringify(differences)}::text::jsonb, ${actor}, ${reason})`];
  }

  async applicationRoleAssignments(organizationId?: string) {
    return (await this.db.query(organizationId
      ? sql`select a.organization_id, o.name as organization_name, a.user_id, u.email, u.name, a.role, a.granted_at, a.granted_by from application_role_assignment a left join organization o on o.id = a.organization_id left join "user" u on u.id = a.user_id where a.organization_id = ${organizationId} and a.revoked_at is null order by u.name, a.role`
      : sql`select a.organization_id, o.name as organization_name, a.user_id, u.email, u.name, a.role, a.granted_at, a.granted_by from application_role_assignment a left join organization o on o.id = a.organization_id left join "user" u on u.id = a.user_id where a.revoked_at is null order by a.granted_at desc limit 200`))
      .map((row) => ({ organizationId: String(row.organization_id), organizationName: String(row.organization_name ?? ""), userId: String(row.user_id), email: String(row.email ?? ""), name: String(row.name ?? ""), role: String(row.role), grantedAt: iso(row.granted_at)!, grantedBy: String(row.granted_by) }));
  }

  async customApplicationRoles(organizationId: string) {
    return (await this.db.query(sql`select key, name, description, permissions from application_role where organization_id = ${organizationId}`)).map((row) => ({ key: String(row.key), name: String(row.name), description: String(row.description ?? ""), permissions: strings(row.permissions) }));
  }

  async membership(organizationId: string, userId: string) {
    const [row] = await this.db.query(sql`select m.role, u.name, u.email from member m join "user" u on u.id = m.user_id where m.organization_id = ${organizationId} and m.user_id = ${userId}`);
    if (!row) return null;
    const applications = await this.db.query(sql`select role from application_role_assignment where organization_id = ${organizationId} and user_id = ${userId} and revoked_at is null`);
    return { name: String(row.name), email: String(row.email), organizationRoles: splitRoles(row.role), applicationRoles: applications.map((assignment) => String(assignment.role)).sort() };
  }

  async serviceAccount(organizationId: string, id: string) {
    const [row] = await this.db.query(sql`select * from service_account where organization_id = ${organizationId} and id = ${id}`);
    return row ? { id: String(row.id), name: String(row.name), status: String(row.status), applicationRoles: strings(row.application_roles) } : null;
  }

  async apiKey(id: string) {
    const [row] = await this.db.query(sql`select id, organization_id, service_account_id, environment, display_prefix, scopes, expires_at, revoked_at, allowed_cidrs from api_key where id = ${id}`);
    return row ? { id: String(row.id), organizationId: String(row.organization_id), serviceAccountId: String(row.service_account_id), environment: String(row.environment) as ApplicationEnvironment, displayPrefix: String(row.display_prefix), scopes: strings(row.scopes), expiresAt: row.expires_at ? new Date(iso(row.expires_at)!) : null, revokedAt: row.revoked_at ? new Date(iso(row.revoked_at)!) : null, allowedCidrs: row.allowed_cidrs ? strings(row.allowed_cidrs) : null } : null;
  }

  async serviceAccounts(organizationId?: string) {
    return (await this.db.query(organizationId
      ? sql`select s.*, o.name as organization_name from service_account s left join organization o on o.id = s.organization_id where s.organization_id = ${organizationId} order by s.created_at desc`
      : sql`select s.*, o.name as organization_name from service_account s left join organization o on o.id = s.organization_id order by s.created_at desc limit 200`))
      .map((row) => ({ id: String(row.id), organizationId: String(row.organization_id), organizationName: String(row.organization_name ?? ""), name: String(row.name), description: String(row.description ?? ""), status: row.deleted_at ? "deleted" as const : String(row.status) as "active" | "suspended", applicationRoles: strings(row.application_roles), createdAt: iso(row.created_at)!, createdBy: String(row.created_by), deletedAt: iso(row.deleted_at) }));
  }

  suspendServiceAccount(id: string, by: string, reason: string): SQL[] {
    return [sql`update service_account set status = 'suspended', suspended_at = now(), suspended_by = ${by}, suspension_reason = ${reason} where id = ${id} and status = 'active' and deleted_at is null`];
  }

  async apiKeys(organizationId?: string) {
    const now = Date.now();
    return (await this.db.query(organizationId
      ? sql`select k.id, k.organization_id, o.name as organization_name, k.service_account_id, s.name as service_account_name, k.name, k.environment, k.display_prefix, k.scopes, k.created_at, k.created_by, k.last_used_at, k.expires_at, k.revoked_at, k.revocation_reason, k.rotated_from, k.rotated_to, k.replaced_by, k.allowed_cidrs
          from api_key k left join organization o on o.id = k.organization_id left join service_account s on s.id = k.service_account_id where k.organization_id = ${organizationId} order by k.created_at desc`
      : sql`select k.id, k.organization_id, o.name as organization_name, k.service_account_id, s.name as service_account_name, k.name, k.environment, k.display_prefix, k.scopes, k.created_at, k.created_by, k.last_used_at, k.expires_at, k.revoked_at, k.revocation_reason, k.rotated_from, k.rotated_to, k.replaced_by, k.allowed_cidrs
          from api_key k left join organization o on o.id = k.organization_id left join service_account s on s.id = k.service_account_id order by k.created_at desc limit 500`))
      .map((row) => ({
        id: String(row.id), organizationId: String(row.organization_id), serviceAccountId: String(row.service_account_id), displayPrefix: String(row.display_prefix), environment: String(row.environment) as never, scopes: strings(row.scopes),
        status: row.revoked_at ? "revoked" : row.expires_at && new Date(iso(row.expires_at)!).getTime() <= now ? "expired" : row.rotated_to ? "rotating" : "active",
        createdAt: iso(row.created_at)!, createdBy: String(row.created_by), lastUsedAt: iso(row.last_used_at), expiresAt: iso(row.expires_at), revokedAt: iso(row.revoked_at), rotatedFrom: row.rotated_from ? String(row.rotated_from) : null,
        name: row.name ? String(row.name) : null, organizationName: String(row.organization_name ?? ""), serviceAccountName: String(row.service_account_name ?? ""), rotatedTo: row.rotated_to ? String(row.rotated_to) : null, replacedBy: row.replaced_by ? String(row.replaced_by) : null,
        revocationReason: row.revocation_reason ? String(row.revocation_reason) : null, allowedCidrs: row.allowed_cidrs ? strings(row.allowed_cidrs) : null,
      }));
  }

  // ---- Access catalog (docs/ADMIN_REQUIRED_CHANGES.md §5) ----

  async catalogPermissionRows() {
    return (await this.db.query(sql`select code, name, description, plane, principals, entitlement, state, created_by, created_at, updated_at, deprecated_at from access_permission order by code`))
      .map((row) => ({ code: String(row.code), name: String(row.name), description: String(row.description), plane: String(row.plane) as "organization" | "application", principals: strings(row.principals), entitlement: row.entitlement ? String(row.entitlement) : null, state: String(row.state) as "active" | "deprecated", createdBy: String(row.created_by), createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!, deprecatedAt: iso(row.deprecated_at) }));
  }

  /** Notification streams (§8.1): one row per stream with its active and draft versions. */
  async notificationStreamRows() {
    const rows = await this.db.query(sql`select s.type, s.name, s.description, s.archived_at,
        (select version from notification_stream_version v where v.type = s.type and v.state = 'active') as active_version,
        (select published_at from notification_stream_version v where v.type = s.type and v.state = 'active') as published_at,
        (select version from notification_stream_version v where v.type = s.type and v.state = 'draft') as draft_version,
        (select definition from notification_stream_version v where v.type = s.type order by (v.state = 'active') desc, version desc limit 1) as definition
      from notification_stream s order by s.archived_at nulls first, s.type`);
    const version = (value: unknown) => value === null || value === undefined ? null : Number(value);
    return rows.map((row) => ({
      type: String(row.type), name: String(row.name), description: String(row.description ?? ""), archivedAt: iso(row.archived_at),
      activeVersion: version(row.active_version), publishedAt: iso(row.published_at), draftVersion: version(row.draft_version), definition: json(row.definition) as Record<string, unknown> | null,
    }));
  }

  async notificationStream(type: string) {
    const [stream] = await this.db.query(sql`select type, name, description, created_by, created_at, archived_at, archived_by from notification_stream where type = ${type}`);
    if (!stream) return null;
    const versions = await this.db.query(sql`select version, state, definition, created_by, created_at, updated_at, published_at, published_by from notification_stream_version where type = ${type} order by version desc`);
    return {
      stream: { type: String(stream.type), name: String(stream.name), description: String(stream.description ?? ""), createdBy: String(stream.created_by), createdAt: iso(stream.created_at), archivedAt: iso(stream.archived_at), archivedBy: stream.archived_by ? String(stream.archived_by) : null },
      versions: versions.map((row) => ({
        version: Number(row.version), state: String(row.state) as "draft" | "active" | "superseded" | "archived", definition: json(row.definition) as Record<string, unknown>, createdBy: String(row.created_by),
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), publishedAt: iso(row.published_at), publishedBy: row.published_by ? String(row.published_by) : null,
      })),
    };
  }

  insertNotificationStream(input: { type: string; name: string; description: string }, definition: unknown, by: string): SQL[] {
    return [
      sql`insert into notification_stream (type, name, description, created_by) values (${input.type}, ${input.name}, ${input.description}, ${by})`,
      sql`insert into notification_stream_version (type, version, state, definition, created_by) values (${input.type}, 1, 'draft', ${JSON.stringify(definition)}::text::jsonb, ${by})`,
    ];
  }

  renameNotificationStream(type: string, input: { name: string; description: string }): SQL[] {
    return [sql`update notification_stream set name = ${input.name}, description = ${input.description} where type = ${type}`];
  }

  insertNotificationStreamDraft(type: string, version: number, definition: unknown, by: string): SQL[] {
    return [sql`insert into notification_stream_version (type, version, state, definition, created_by) values (${type}, ${version}, 'draft', ${JSON.stringify(definition)}::text::jsonb, ${by})`];
  }

  updateNotificationStreamDraft(type: string, version: number, definition: unknown): SQL[] {
    return [sql`update notification_stream_version set definition = ${JSON.stringify(definition)}::text::jsonb, updated_at = now() where type = ${type} and version = ${version} and state = 'draft'`];
  }

  deleteNotificationStreamDraft(type: string, version: number): SQL[] {
    return [sql`delete from notification_stream_version where type = ${type} and version = ${version} and state = 'draft'`];
  }

  /** The previous active version is superseded in the same transaction; the partial unique index keeps one active. */
  publishNotificationStream(type: string, version: number, by: string): SQL[] {
    return [
      sql`update notification_stream_version set state = 'superseded', updated_at = now() where type = ${type} and state = 'active'`,
      sql`update notification_stream_version set state = 'active', published_at = now(), published_by = ${by}, updated_at = now() where type = ${type} and version = ${version} and state = 'draft'`,
    ];
  }

  setNotificationStreamArchived(type: string, archived: boolean, by: string): SQL[] {
    return [archived
      ? sql`update notification_stream set archived_at = now(), archived_by = ${by} where type = ${type}`
      : sql`update notification_stream set archived_at = null, archived_by = null where type = ${type}`];
  }

  async catalogRoleRows() {
    return (await this.db.query(sql`select plane, key, name, description, permissions, based_on, archived_at, created_by, created_at, updated_at from access_role order by plane, key`))
      .map((row) => ({ plane: String(row.plane) as "organization" | "application", key: String(row.key), name: String(row.name), description: String(row.description ?? ""), permissions: strings(row.permissions), basedOn: row.based_on ? String(row.based_on) : null, archivedAt: iso(row.archived_at), createdBy: String(row.created_by), createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)! }));
  }

  /** How many principals hold each role key, per plane: members, users, and live service accounts. */
  async roleAssignmentCounts(): Promise<{ organization: Record<string, number>; application: Record<string, number> }> {
    const [organization, users, accounts] = await Promise.all([
      this.db.query(sql`select trim(r) as role, count(*)::int as count from member m, unnest(string_to_array(m.role, ',')) r group by 1`),
      this.db.query(sql`select role, count(*)::int as count from application_role_assignment where revoked_at is null group by role`),
      this.db.query(sql`select r as role, count(*)::int as count from service_account s, unnest(s.application_roles) r where s.deleted_at is null group by r`),
    ]);
    const application: Record<string, number> = {};
    for (const row of [...users, ...accounts]) application[String(row.role)] = (application[String(row.role)] ?? 0) + Number(row.count);
    return { organization: Object.fromEntries(organization.map((row) => [String(row.role), Number(row.count)])), application };
  }

  /** The principals holding one role, with human names first. */
  async roleAssignments(plane: "organization" | "application", key: string) {
    if (plane === "organization") {
      return (await this.db.query(sql`select m.id as member_id, m.organization_id, o.name as organization_name, u.id as user_id, u.name, u.email, m.role from member m join "user" u on u.id = m.user_id left join organization o on o.id = m.organization_id
        where ${key} = any(string_to_array(replace(m.role, ' ', ''), ',')) order by o.name, u.name limit 500`))
        .map((row) => ({ kind: "member" as const, id: String(row.member_id), organizationId: String(row.organization_id), organizationName: String(row.organization_name ?? ""), principalId: String(row.user_id), name: String(row.name), detail: String(row.email) }));
    }
    const [users, accounts] = await Promise.all([
      this.db.query(sql`select a.organization_id, o.name as organization_name, u.id as user_id, u.name, u.email from application_role_assignment a join "user" u on u.id = a.user_id left join organization o on o.id = a.organization_id
        where a.role = ${key} and a.revoked_at is null order by o.name, u.name limit 500`),
      this.db.query(sql`select s.id, s.organization_id, o.name as organization_name, s.name from service_account s left join organization o on o.id = s.organization_id where ${key} = any(s.application_roles) and s.deleted_at is null order by o.name, s.name limit 500`),
    ]);
    return [
      ...users.map((row) => ({ kind: "user" as const, id: `${String(row.organization_id)}:${String(row.user_id)}`, organizationId: String(row.organization_id), organizationName: String(row.organization_name ?? ""), principalId: String(row.user_id), name: String(row.name), detail: String(row.email) })),
      ...accounts.map((row) => ({ kind: "service_account" as const, id: String(row.id), organizationId: String(row.organization_id), organizationName: String(row.organization_name ?? ""), principalId: String(row.id), name: String(row.name), detail: "service account" })),
    ];
  }

  /** Where a permission code is still referenced: tenant roles and live API-key scopes. */
  async permissionReferences(code: string) {
    const [tenantRoles, keys] = await Promise.all([
      this.db.query(sql`select r.organization_id, o.name as organization_name, r.key, r.name from application_role r left join organization o on o.id = r.organization_id where ${code} = any(r.permissions) order by o.name, r.key limit 100`),
      this.db.query(sql`select count(*)::int as count from api_key where ${code} = any(scopes) and revoked_at is null and (expires_at is null or expires_at > now())`),
    ]);
    return {
      tenantRoles: tenantRoles.map((row) => ({ organizationId: String(row.organization_id), organizationName: String(row.organization_name ?? ""), key: String(row.key), name: String(row.name) })),
      activeKeys: Number(keys[0]?.count ?? 0),
    };
  }

  insertCatalogPermission(input: { code: string; name: string; description: string; plane: string; principals: readonly string[]; entitlement: string | null }, by: string): SQL[] {
    return [sql`insert into access_permission (code, name, description, plane, principals, entitlement, created_by) values (${input.code}, ${input.name}, ${input.description}, ${input.plane}, ${textArray(input.principals)}, ${input.entitlement}, ${by})`];
  }

  updateCatalogPermission(code: string, input: { name: string; description: string; principals: readonly string[]; entitlement: string | null }): SQL[] {
    return [sql`update access_permission set name = ${input.name}, description = ${input.description}, principals = ${textArray(input.principals)}, entitlement = ${input.entitlement}, updated_at = now() where code = ${code}`];
  }

  setCatalogPermissionState(code: string, state: "active" | "deprecated"): SQL[] {
    return [sql`update access_permission set state = ${state}, deprecated_at = ${state === "deprecated" ? sql`now()` : null}, updated_at = now() where code = ${code}`];
  }

  deleteCatalogPermission(code: string): SQL[] {
    return [sql`delete from access_permission where code = ${code}`];
  }

  insertCatalogRole(input: { plane: string; key: string; name: string; description: string; permissions: readonly string[]; basedOn: string | null }, by: string): SQL[] {
    return [sql`insert into access_role (plane, key, name, description, permissions, based_on, created_by) values (${input.plane}, ${input.key}, ${input.name}, ${input.description}, ${textArray(input.permissions)}, ${input.basedOn}, ${by})`];
  }

  updateCatalogRole(plane: string, key: string, input: { name: string; description: string; permissions: readonly string[] }): SQL[] {
    return [sql`update access_role set name = ${input.name}, description = ${input.description}, permissions = ${textArray(input.permissions)}, updated_at = now() where plane = ${plane} and key = ${key}`];
  }

  setCatalogRoleArchived(plane: string, key: string, archived: boolean): SQL[] {
    return [sql`update access_role set archived_at = ${archived ? sql`now()` : null}, updated_at = now() where plane = ${plane} and key = ${key}`];
  }

  deleteCatalogRole(plane: string, key: string): SQL[] {
    return [sql`delete from access_role where plane = ${plane} and key = ${key}`];
  }

  /** Application role keys already used by a tenant's own roles, which a catalog role must not shadow. */
  async tenantRoleKeyTaken(key: string): Promise<boolean> {
    return (await this.db.query(sql`select 1 from application_role where key = ${key} limit 1`)).length > 0;
  }

  // ---- Machine access detail (§6) ----

  async serviceAccountById(id: string) {
    const [row] = await this.db.query(sql`select s.*, o.name as organization_name from service_account s left join organization o on o.id = s.organization_id where s.id = ${id}`);
    return row ? {
      id: String(row.id), organizationId: String(row.organization_id), organizationName: String(row.organization_name ?? ""), name: String(row.name), description: String(row.description ?? ""),
      status: row.deleted_at ? "deleted" as const : String(row.status) as "active" | "suspended", applicationRoles: strings(row.application_roles), createdAt: iso(row.created_at)!, createdBy: String(row.created_by),
      suspendedAt: iso(row.suspended_at), suspensionReason: row.suspension_reason ? String(row.suspension_reason) : null, deletedAt: iso(row.deleted_at), deletedBy: row.deleted_by ? String(row.deleted_by) : null, deletionReason: row.deletion_reason ? String(row.deletion_reason) : null,
    } : null;
  }

  async apiKeyUsageDays(keyIds: readonly string[]) {
    if (!keyIds.length) return [];
    return (await this.db.query(sql`select api_key_id, day::text as day, requests, denied from api_key_usage where api_key_id = any(${textArray(keyIds)}) and day > current_date - 30 order by day desc`))
      .map((row) => ({ keyId: String(row.api_key_id), day: String(row.day), requests: Number(row.requests), denied: Number(row.denied) }));
  }

  async auditFor(targetType: string, targetIds: readonly string[], limit = 50) {
    if (!targetIds.length) return [];
    return (await this.db.query(sql`select id, occurred_at, name, actor_type, actor_id, reason, outcome, correlation_id, target_id from audit_event where target_type = ${targetType} and target_id = any(${textArray(targetIds)}) order by occurred_at desc limit ${limit}`))
      .map((row) => ({ id: String(row.id), occurredAt: iso(row.occurred_at)!, name: String(row.name), actorType: String(row.actor_type), actor: String(row.actor_id), reason: row.reason ? String(row.reason) : null, outcome: String(row.outcome), correlationId: String(row.correlation_id), targetId: String(row.target_id) }));
  }

  revokeApiKey(id: string, by: string, reason: string): SQL[] {
    return [sql`update api_key set revoked_at = now(), revoked_by = ${by}, revocation_reason = ${reason} where id = ${id} and revoked_at is null`];
  }

  /** Recorded sends with the latest provider webhook status; never message content. */
  /**
   * Enterprise identity across tenants: bindings, SSO providers, SCIM
   * connections and credential status, and recent directory events. Client
   * secrets, IdP configuration, token digests, and provisioned emails are not
   * readable by the platform role.
   */
  async identityStatus() {
    const [connections, providers, scim, credentials, events] = await Promise.all([
      this.db.query(sql`select c.organization_id, o.name as organization_name, c.provider, c.kind, c.external_id, c.domain, c.state, c.last_event_at, c.last_error, c.created_at,
        (select count(*)::int from external_role_mapping m where m.organization_id = c.organization_id and m.connection_id = c.external_id) as mappings
        from identity_connection c left join organization o on o.id = c.organization_id order by o.name, c.kind, c.provider`),
      this.db.query(sql`select p.provider_id, p.organization_id, o.name as organization_name, p.issuer, p.domain, p.domain_verified from sso_provider p left join organization o on o.id = p.organization_id order by o.name, p.provider_id`),
      this.db.query(sql`select c.id, c.connection_id, c.provisioning_domain_id, o.name as organization_name, c.status, c.created_at,
        (select count(*)::int from scim_user u where u.connection_id = c.connection_id and u.active) as active_users
        from scim_managed_connection c left join organization o on o.id = c.provisioning_domain_id order by c.created_at desc limit 200`),
      this.db.query(sql`select connection_record_id, credential_id, status, expires_at, last_used_at from scim_managed_credential order by created_at desc limit 500`),
      this.db.query(sql`select e.id, e.organization_id, o.name as organization_name, e.provider, e.type, e.outcome, e.received_at from directory_event e left join organization o on o.id = e.organization_id order by e.received_at desc limit 50`),
    ]);
    const text = (value: unknown) => value === null || value === undefined ? null : String(value);
    return {
      connections: connections.map((row) => ({ organizationId: String(row.organization_id), organizationName: text(row.organization_name), provider: String(row.provider), kind: String(row.kind), externalId: String(row.external_id), domain: text(row.domain), state: String(row.state), lastEventAt: iso(row.last_event_at), lastError: text(row.last_error), mappings: Number(row.mappings ?? 0), createdAt: iso(row.created_at)! })),
      ssoProviders: providers.map((row) => ({ providerId: String(row.provider_id), organizationId: text(row.organization_id), organizationName: text(row.organization_name), issuer: String(row.issuer), domain: String(row.domain), domainVerified: row.domain_verified === true })),
      scim: scim.map((row) => {
        const own = credentials.filter((credential) => credential.connection_record_id === row.id);
        const active = own.find((credential) => credential.status === "active");
        return { connectionId: String(row.connection_id), organizationId: String(row.provisioning_domain_id), organizationName: text(row.organization_name), status: String(row.status), activeUsers: Number(row.active_users ?? 0), createdAt: iso(row.created_at)!,
          credential: active ? { credentialId: String(active.credential_id), expiresAt: iso(active.expires_at), lastUsedAt: iso(active.last_used_at) } : null };
      }),
      events: events.map((row) => ({ id: String(row.id), organizationId: String(row.organization_id), organizationName: text(row.organization_name), provider: String(row.provider), type: String(row.type), outcome: String(row.outcome), receivedAt: iso(row.received_at)! })),
    };
  }

  async emailDeliveries(status?: string) {
    return (await this.db.query(sql`select d.id, d.provider, d.template, d.recipient_masked, d.status as recorded_status, d.failure_category, d.correlation_id, d.created_at, e.status as event_status, e.occurred_at as event_at,
        (select count(*) from email_delivery_event x where x.email_delivery_id = d.id) as event_count
      from email_delivery d left join lateral (select status, occurred_at from email_delivery_event where email_delivery_id = d.id order by occurred_at desc limit 1) e on true
      where ${status ? sql`coalesce(e.status, d.status) = ${status}` : sql`true`} order by d.created_at desc limit 200`))
      .map((row) => ({
        id: String(row.id), provider: String(row.provider), template: String(row.template), recipient: String(row.recipient_masked),
        status: String(row.event_status ?? row.recorded_status), ...(row.failure_category ? { failureCategory: String(row.failure_category) } : {}),
        correlationId: row.correlation_id ? String(row.correlation_id) : "—", occurredAt: iso(row.event_at ?? row.created_at)!, events: Number(row.event_count ?? 0),
      }));
  }

  /** One send with its provider event timeline and, for notification email, the attempt count. Never content. */
  async emailDeliveryDetail(id: string) {
    const [row] = await this.db.query(sql`select d.id, d.provider, d.template, d.recipient_masked, d.recipient_count, d.status, d.failure_category, d.correlation_id, d.organization_id, o.name as organization_name, d.created_at
      from email_delivery d left join organization o on o.id = d.organization_id where d.id = ${id}`);
    if (!row) return null;
    const events = await this.db.query(sql`select status, occurred_at, received_at from email_delivery_event where email_delivery_id = ${id} order by occurred_at`);
    const [notification] = await this.db.query(sql`select d.id, n.type, d.attempts, d.status, d.failure_category from notification_delivery d join notification n on n.id = d.notification_id where d.email_delivery_id = ${id} limit 1`);
    return {
      delivery: {
        id: String(row.id), provider: String(row.provider), template: String(row.template), recipient: String(row.recipient_masked), recipientCount: Number(row.recipient_count ?? 1), status: String(row.status),
        failureCategory: row.failure_category ? String(row.failure_category) : null, correlationId: row.correlation_id ? String(row.correlation_id) : null,
        organizationId: row.organization_id ? String(row.organization_id) : null, organizationName: row.organization_name ? String(row.organization_name) : null, createdAt: iso(row.created_at)!,
      },
      events: events.map((event) => ({ status: String(event.status), occurredAt: iso(event.occurred_at)!, receivedAt: iso(event.received_at)! })),
      notification: notification ? { deliveryId: String(notification.id), type: String(notification.type), attempts: Number(notification.attempts), status: String(notification.status), failureCategory: notification.failure_category ? String(notification.failure_category) : null } : null,
    };
  }

  /** Cross-tenant endpoint health. Only sanitized columns are granted: never the raw URL or any secret. */
  async webhookEndpoints(filter: Readonly<{ id?: string; organizationId?: string; state?: string; q?: string; includeDeleted?: boolean }>) {
    const clauses: SQL[] = [sql`true`];
    // Deleted endpoints are tombstones: listed only on request, always reachable by ID for history.
    if (!filter.id && !filter.includeDeleted) clauses.push(sql`e.deleted_at is null`);
    if (filter.id) clauses.push(sql`e.id = ${filter.id}`);
    if (filter.organizationId) clauses.push(sql`e.organization_id = ${filter.organizationId}`);
    if (filter.state) clauses.push(sql`e.state = ${filter.state}`);
    if (filter.q) clauses.push(sql`(e.name ilike ${like(filter.q)} or e.url_display ilike ${like(filter.q)} or o.name ilike ${like(filter.q)})`);
    return (await this.db.query(sql`select e.id, e.organization_id, o.name as organization_name, e.name, e.url_display, e.events, e.state, e.disabled_reason, e.disabled_by, e.consecutive_failures, e.secret_fingerprint, e.verified_at, e.last_success_at, e.last_failure_at, e.created_at, e.description, e.timeout_ms, e.deleted_at,
        (select count(*) from webhook_delivery d where d.endpoint_id = e.id and d.status = 'failed' and d.created_at > now() - interval '24 hours') as failed_24h,
        (select count(*) from webhook_delivery d where d.endpoint_id = e.id and d.status = 'pending') as pending
      from webhook_endpoint e left join organization o on o.id = e.organization_id where ${sql.join(clauses, sql` and `)} order by e.consecutive_failures desc, e.created_at desc limit 200`))
      .map((row) => ({
        id: String(row.id), organizationId: String(row.organization_id), organizationName: String(row.organization_name ?? ""), name: String(row.name), url: String(row.url_display), events: strings(row.events), state: String(row.state),
        disabledReason: row.disabled_reason ? String(row.disabled_reason) : null, disabledBy: row.disabled_by ? String(row.disabled_by) : null, consecutiveFailures: Number(row.consecutive_failures), secretFingerprint: String(row.secret_fingerprint),
        verifiedAt: iso(row.verified_at), lastSuccessAt: iso(row.last_success_at), lastFailureAt: iso(row.last_failure_at), createdAt: iso(row.created_at)!, failed24h: Number(row.failed_24h), pending: Number(row.pending),
        description: row.description ? String(row.description) : null, timeoutMs: Number(row.timeout_ms ?? 10_000), deletedAt: iso(row.deleted_at),
      }));
  }

  async webhookDeliveries(endpointId: string) {
    const deliveries = await this.db.query(sql`select id, organization_id, endpoint_id, event_id, event_name, event_version, status, attempts, next_attempt_at, last_response_code, failure_category, correlation_id, test, replay_of, created_at, completed_at
      from webhook_delivery where endpoint_id = ${endpointId} order by created_at desc limit 50`);
    const ids = deliveries.map((row) => String(row.id));
    const attempts = ids.length ? await this.db.query(sql`select delivery_id, attempted_at, response_code, failure_category, duration_ms from webhook_attempt where delivery_id = any(${`{${ids.map((value) => `"${value}"`).join(",")}}`}::text[]) order by attempted_at`) : [];
    return deliveries.map((row) => ({
      id: String(row.id), organizationId: String(row.organization_id), eventId: String(row.event_id), event: String(row.event_name), version: Number(row.event_version), status: String(row.status), attempts: Number(row.attempts),
      responseCode: row.last_response_code === null ? null : Number(row.last_response_code), failureCategory: row.failure_category ? String(row.failure_category) : null, correlationId: String(row.correlation_id), test: row.test === true, replayOf: row.replay_of ? String(row.replay_of) : null,
      createdAt: iso(row.created_at)!, completedAt: iso(row.completed_at), nextAttemptAt: row.status === "pending" ? iso(row.next_attempt_at) : null,
      history: attempts.filter((attempt) => attempt.delivery_id === row.id).map((attempt) => ({ attemptedAt: iso(attempt.attempted_at)!, responseCode: attempt.response_code === null ? null : Number(attempt.response_code), failureCategory: attempt.failure_category ? String(attempt.failure_category) : null, durationMs: Number(attempt.duration_ms) })),
    }));
  }

  async webhookDelivery(id: string) {
    const [row] = await this.db.query(sql`select d.id, d.organization_id, d.endpoint_id, d.status, d.test, d.event_name, e.state as endpoint_state from webhook_delivery d join webhook_endpoint e on e.id = d.endpoint_id where d.id = ${id}`);
    return row ? { id: String(row.id), organizationId: String(row.organization_id), endpointId: String(row.endpoint_id), status: String(row.status), test: row.test === true, event: String(row.event_name), endpointState: String(row.endpoint_state) } : null;
  }

  disableWebhookEndpoint(id: string, by: string, reason: string): SQL[] {
    return [
      sql`update webhook_endpoint set state = 'disabled', disabled_reason = ${reason}, disabled_by = ${`platform:${by}`}, disabled_at = now(), updated_at = now() where id = ${id} and state <> 'disabled'`,
      sql`update webhook_delivery set status = 'cancelled', completed_at = now() where endpoint_id = ${id} and status = 'pending'`,
    ];
  }

  /** Copies the delivery, payload included, inside the database; the platform role never reads the payload. */
  replayWebhookDelivery(id: string, replayId: string, correlationId: string): SQL[] {
    return [sql`select trestle_replay_webhook_delivery(${id}, ${replayId}, ${correlationId})`];
  }

  /** Notification metadata across tenants: type, recipient, channel states; never title, body, or link. */
  async notifications(filter: Readonly<{ organizationId?: string; status?: string; type?: string }>) {
    const clauses: SQL[] = [sql`true`];
    if (filter.organizationId) clauses.push(sql`n.organization_id = ${filter.organizationId}`);
    if (filter.type) clauses.push(sql`n.type = ${filter.type}`);
    if (filter.status) clauses.push(sql`exists (select 1 from notification_delivery x where x.notification_id = n.id and x.status = ${filter.status})`);
    return (await this.db.query(sql`select n.id, n.organization_id, o.name as organization_name, n.user_id, u.name as user_name, u.email as user_email, n.type, n.group_count, n.correlation_id, n.created_at, n.updated_at, n.scheduled_at, n.read_at,
        coalesce((select json_agg(json_build_object('id', d.id, 'channel', d.channel, 'status', d.status, 'failureCategory', d.failure_category, 'attempts', d.attempts) order by d.channel) from notification_delivery d where d.notification_id = n.id), '[]'::json) as deliveries
      from notification n left join organization o on o.id = n.organization_id left join "user" u on u.id = n.user_id where ${sql.join(clauses, sql` and `)} order by n.updated_at desc limit 200`))
      .map((row) => {
        const deliveries = (typeof row.deliveries === "string" ? JSON.parse(row.deliveries) : row.deliveries) as Array<{ id: string; channel: string; status: string; failureCategory: string | null; attempts: number }>;
        return {
          id: String(row.id), organizationId: String(row.organization_id), organizationName: String(row.organization_name ?? ""), recipient: { userId: String(row.user_id), name: String(row.user_name ?? "Former member"), email: maskEmail(String(row.user_email ?? "")) },
          type: String(row.type), groupCount: Number(row.group_count), correlationId: String(row.correlation_id), createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!, scheduledAt: iso(row.scheduled_at)!, readAt: iso(row.read_at),
          channels: deliveries, failureCategory: deliveries.find((delivery) => delivery.failureCategory)?.failureCategory ?? null,
        };
      });
  }

  async notificationDetail(id: string) {
    const [row] = await this.db.query(sql`select n.id, n.organization_id, o.name as organization_name, n.user_id, u.name as user_name, u.email as user_email, n.type, n.group_key, n.group_count, n.dedupe_key, n.event_id, n.correlation_id, n.created_at, n.updated_at, n.scheduled_at, n.read_at
      from notification n left join organization o on o.id = n.organization_id left join "user" u on u.id = n.user_id where n.id = ${id}`);
    if (!row) return null;
    const [deliveries, preferences] = await Promise.all([
      this.db.query(sql`select d.*, ed.status as email_status, (select status from email_delivery_event ev where ev.email_delivery_id = d.email_delivery_id order by ev.occurred_at desc limit 1) as email_event_status
        from notification_delivery d left join email_delivery ed on ed.id = d.email_delivery_id where d.notification_id = ${id} order by d.channel`),
      this.db.query(sql`select user_id, channel, enabled from notification_preference where organization_id = ${String(row.organization_id)} and type = ${String(row.type)} and user_id in (${String(row.user_id)}, '*')`),
    ]);
    return {
      notification: {
        id: String(row.id), organizationId: String(row.organization_id), organizationName: String(row.organization_name ?? ""), recipient: { userId: String(row.user_id), name: String(row.user_name ?? "Former member"), email: maskEmail(String(row.user_email ?? "")) },
        type: String(row.type), groupKey: row.group_key ? String(row.group_key) : null, groupCount: Number(row.group_count), dedupeKey: row.dedupe_key ? String(row.dedupe_key) : null, eventId: row.event_id ? String(row.event_id) : null,
        correlationId: String(row.correlation_id), createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!, scheduledAt: iso(row.scheduled_at)!, readAt: iso(row.read_at),
      },
      deliveries: deliveries.map((delivery) => ({
        id: String(delivery.id), channel: String(delivery.channel), status: String(delivery.status), preferenceSource: String(delivery.preference_source), mandatory: delivery.mandatory === true, attempts: Number(delivery.attempts),
        failureCategory: delivery.failure_category ? String(delivery.failure_category) : null, emailDeliveryId: delivery.email_delivery_id ? String(delivery.email_delivery_id) : null, providerStatus: delivery.email_event_status ? String(delivery.email_event_status) : delivery.email_status ? String(delivery.email_status) : null,
        createdAt: iso(delivery.created_at)!, completedAt: iso(delivery.completed_at), nextAttemptAt: delivery.status === "pending" ? iso(delivery.next_attempt_at) : null,
      })),
      preferences: preferences.map((preference) => ({ scope: preference.user_id === "*" ? "organization" : "user", channel: String(preference.channel), enabled: preference.enabled === true })),
    };
  }

  async notificationDelivery(id: string) {
    const [row] = await this.db.query(sql`select d.id, d.organization_id, d.status, d.mandatory, d.channel, n.type from notification_delivery d join notification n on n.id = d.notification_id where d.id = ${id}`);
    return row ? { id: String(row.id), organizationId: String(row.organization_id), status: String(row.status), mandatory: row.mandatory === true, channel: String(row.channel), type: String(row.type) } : null;
  }

  retryNotificationDelivery(id: string): SQL[] {
    return [sql`update notification_delivery set status = 'pending', next_attempt_at = now(), failure_category = null, completed_at = null where id = ${id} and status = 'failed'`];
  }

  cancelNotificationDelivery(id: string): SQL[] {
    return [sql`update notification_delivery set status = 'cancelled', completed_at = now() where id = ${id} and status = 'pending' and mandatory = false`];
  }

  async outbox() {
    const counts = await this.db.query(sql`select status, count(*) as total from outbox_message group by status`);
    const total = (status: string) => Number(counts.find((row) => row.status === status)?.total ?? 0);
    const dead = await this.db.query(sql`select id, event_name, attempts, last_error, available_at from outbox_message where status = 'dead' order by available_at limit 200`);
    return {
      outbox: { pending: total("pending"), leased: total("leased"), succeeded: total("succeeded"), dead: total("dead") },
      // Error text can carry payload fragments; only a coarse category leaves the platform role.
      dead: dead.map((row) => ({ id: String(row.id), event: String(row.event_name), attempts: Number(row.attempts), lastErrorCategory: categorize(String(row.last_error ?? "")), availableAt: iso(row.available_at)! })),
    };
  }

  redrive(id: string): SQL[] {
    return [sql`update outbox_message set status = 'pending', available_at = now(), leased_until = null, last_error = null where id = ${id} and status = 'dead'`];
  }

  async isDead(id: string): Promise<boolean> {
    return (await this.db.query(sql`select 1 from outbox_message where id = ${id} and status = 'dead'`)).length === 1;
  }

  async artifacts(organizationId: string | undefined, retentionDays: number) {
    return (await this.db.query(organizationId
      ? sql`select id, organization_id, content_type, size, created_at, deleted_at from artifact_metadata where organization_id = ${organizationId} order by created_at desc limit 200`
      : sql`select id, organization_id, content_type, size, created_at, deleted_at from artifact_metadata order by created_at desc limit 200`))
      .map((row) => {
        const created = new Date(iso(row.created_at)!);
        return { id: String(row.id), organizationId: String(row.organization_id), contentType: String(row.content_type), size: Number(row.size), createdAt: created.toISOString(), deletedAt: iso(row.deleted_at), retention: `expires ${new Date(created.getTime() + retentionDays * 86_400_000).toISOString().slice(0, 10)}` };
      });
  }

  /** One page of audit events, newest first, with the total for server-side pagination. */
  async audit(filters: { organizationId?: string; actor?: string; name?: string; correlationId?: string; id?: string }, page: Readonly<{ limit: number; offset: number }> = { limit: 200, offset: 0 }) {
    const clauses: SQL[] = [sql`true`];
    if (filters.id) clauses.push(sql`a.id::text = ${filters.id}`);
    if (filters.correlationId) clauses.push(sql`a.correlation_id = ${filters.correlationId}`);
    if (filters.organizationId) clauses.push(sql`a.organization_id = ${filters.organizationId}`);
    if (filters.actor) clauses.push(sql`(a.actor_id = ${filters.actor} or u.email ilike ${`${filters.actor.replaceAll("%", "")}%`})`);
    if (filters.name) clauses.push(sql`a.name like ${`${filters.name.replaceAll("%", "")}%`}`);
    const where = sql.join(clauses, sql` and `);
    const [rows, [count]] = await Promise.all([
      this.db.query(sql`select a.id, a.occurred_at, a.name, a.actor_type, a.actor_id, u.email as actor_email, a.organization_id, o.name as organization_name, a.target_type, a.target_id, a.reason, a.outcome, a.correlation_id, a.environment, a.support_session_id
        from audit_event a left join "user" u on u.id = a.actor_id left join organization o on o.id = a.organization_id
        where ${where} order by a.occurred_at desc, a.id desc limit ${page.limit} offset ${page.offset}`),
      this.db.query(sql`select count(*) as total from audit_event a left join "user" u on u.id = a.actor_id where ${where}`),
    ]);
    return {
      total: Number(count?.total ?? 0),
      events: rows.map((row) => ({
        id: String(row.id), name: String(row.name), occurredAt: iso(row.occurred_at)!, actor: String(row.actor_id), actorType: String(row.actor_type), ...(row.actor_email ? { actorEmail: String(row.actor_email) } : {}),
        organizationId: row.organization_id ? String(row.organization_id) : null, ...(row.organization_name ? { organizationName: String(row.organization_name) } : {}), target: `${String(row.target_type)}:${String(row.target_id)}`,
        ...(row.reason ? { reason: String(row.reason) } : {}), outcome: String(row.outcome), correlationId: String(row.correlation_id), environment: String(row.environment), ...(row.support_session_id ? { supportSessionId: String(row.support_session_id) } : {}),
      })),
    };
  }

  async ping(): Promise<boolean> {
    try { await this.db.query(sql`select 1`); return true; } catch { return false; }
  }
}

function supportSession(row: SqlRow) {
  const permissions = (typeof row.permissions === "string" ? JSON.parse(row.permissions) : row.permissions) as { organization: string[]; application: string[]; denied: string[] };
  return {
    id: String(row.id), operatorId: String(row.operator_id), organizationId: String(row.organization_id), organizationName: String(row.organization_name ?? ""), reason: String(row.reason), ticket: row.ticket ? String(row.ticket) : null,
    profile: String(row.profile), permissions, startedAt: iso(row.started_at)!, expiresAt: iso(row.expires_at)!, endedAt: iso(row.ended_at), endReason: row.end_reason ? String(row.end_reason) : null,
    endedBy: row.ended_by ? String(row.ended_by) : null, revocationReason: row.revocation_reason ? String(row.revocation_reason) : null,
  };
}

export type SupportSessionRecord = ReturnType<typeof supportSession>;

/** Logical recipient for operators: first character and domain only. */
export function maskEmail(address: string): string {
  const [local, domain] = address.split("@");
  return local && domain ? `${local[0]}***@${domain}` : "unknown";
}

export function categorize(error: string): string {
  if (!error) return "unknown";
  if (/timeout|timed out/iu.test(error)) return "timeout";
  if (/rate|429/iu.test(error)) return "rate_limited";
  if (/unauthori[sz]ed|forbidden|40[13]/iu.test(error)) return "authorization";
  if (/valid|schema|parse/iu.test(error)) return "invalid_payload";
  if (/network|fetch|ECONN|5\d\d/iu.test(error)) return "provider_unavailable";
  return "handler_error";
}

export type PlatformRepository = PostgresPlatformRepository;
export type { SqlRow };
