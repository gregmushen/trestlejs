import postgres from "postgres";

export type RuntimeRoleStatus = {
  role: string;
  canLogin: boolean;
  superuser: boolean;
  bypassRls: boolean;
  memberOfApplicationRole: boolean;
  /** A tenant runtime login must never be able to assume trestle_platform. */
  memberOfPlatformRole?: boolean;
};

export type PlatformRoleStatus = {
  role: string;
  canLogin: boolean;
  superuser: boolean;
  bypassRls: boolean;
  memberOfPlatformRole: boolean;
  memberOfApplicationRole: boolean;
};

const platformRoleExists = `exists (select 1 from pg_roles where rolname = 'trestle_platform')`;

function validateRoleName(role: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/u.test(role)) throw new Error("Invalid PostgreSQL runtime role name");
  if (role === "trestle_app" || role === "trestle_platform") throw new Error("The runtime login role must be distinct from trestle_app and trestle_platform");
  return role;
}

export async function bootstrapRuntimeRole(connectionString: string, runtimeRole: string, password: string): Promise<{ role: string; created: boolean }> {
  const role = validateRoleName(runtimeRole);
  if (!password || /[\r\n]/u.test(password)) throw new Error("PostgreSQL runtime role password is invalid");
  const sql = postgres(connectionString, { max: 1, prepare: false });
  try {
    const [record] = await sql<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = ${role}
    `;
    if (record && (!record.rolcanlogin || record.rolsuper || record.rolbypassrls)) {
      throw new Error(`PostgreSQL runtime role ${role} is not a restricted login role`);
    }
    const [statement] = await sql<{ statement: string }[]>`
      select format(
        ${record
          ? "alter role %I login password %L noinherit"
          : "create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls"},
        ${role}::text,
        ${password}::text
      ) as statement
    `;
    if (!statement) throw new Error("Unable to construct the PostgreSQL runtime role statement");
    await sql.unsafe(statement.statement);
    return { role, created: !record };
  } finally {
    await sql.end();
  }
}

export async function configureRuntimeRole(connectionString: string, runtimeRole: string): Promise<RuntimeRoleStatus> {
  const role = validateRoleName(runtimeRole);
  const sql = postgres(connectionString, { max: 1, prepare: false });
  try {
    const [record] = await sql<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = ${role}
    `;
    if (!record) throw new Error(`PostgreSQL runtime role ${role} does not exist`);
    if (!record.rolcanlogin) throw new Error(`PostgreSQL runtime role ${role} cannot log in`);
    if (record.rolsuper || record.rolbypassrls) throw new Error(`PostgreSQL runtime role ${role} can bypass row-level security`);
    const [platform] = await sql<{ member: boolean }[]>`select case when ${sql.unsafe(platformRoleExists)} then pg_has_role(${role}, 'trestle_platform', 'MEMBER') else false end as member`;
    if (platform?.member) throw new Error(`PostgreSQL runtime role ${role} can assume trestle_platform; use a distinct admin login`);
    await sql`grant trestle_app to ${sql(role)}`;
    await sql`grant usage on schema public to ${sql(role)}`;
    // The login role serves Better Auth and verified provider-event receipts
    // without assuming the tenant role. Never grant it tenant-owned tables;
    // those remain accessible only after SET ROLE trestle_app and RLS context.
    for (const table of ["user", "session", "account", "verification", "organization", "member", "invitation", "billing_provider_event", "email_delivery_event", "two_factor", "passkey"]) {
      await sql`grant select, insert, update, delete on ${sql(table)} to ${sql(role)}`;
    }
    await sql`grant select, insert, update on artifact_maintenance_cursor to ${sql(role)}`;
    // Session assurance is written by the auth hook and read by the admin Worker.
    await sql`grant select, insert, update on authentication_assurance to ${sql(role)}`;
    // Account-security events go through the SECURITY DEFINER function, never a direct audit_event insert.
    await sql`grant execute on function trestle_record_security_event(text, text, text, text) to ${sql(role)}`;
    return {
      role,
      canLogin: record.rolcanlogin,
      superuser: record.rolsuper,
      bypassRls: record.rolbypassrls,
      memberOfApplicationRole: true,
      memberOfPlatformRole: false,
    };
  } finally {
    await sql.end();
  }
}

export async function inspectRuntimeRole(connectionString: string): Promise<RuntimeRoleStatus> {
  const sql = postgres(connectionString, { max: 1, prepare: false });
  try {
    const [record] = await sql<{ role: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; app_member: boolean; platform_member: boolean }[]>`
      select current_user as role,
             rolcanlogin,
             rolsuper,
             rolbypassrls,
             pg_has_role(current_user, 'trestle_app', 'MEMBER') as app_member,
             case when ${sql.unsafe(platformRoleExists)} then pg_has_role(current_user, 'trestle_platform', 'MEMBER') else false end as platform_member
        from pg_roles
       where rolname = current_user
    `;
    if (!record) throw new Error("Unable to inspect the PostgreSQL runtime role");
    return {
      role: record.role,
      canLogin: record.rolcanlogin,
      superuser: record.rolsuper,
      bypassRls: record.rolbypassrls,
      memberOfApplicationRole: record.app_member,
      memberOfPlatformRole: record.platform_member,
    };
  } finally {
    await sql.end();
  }
}

export function assertRuntimeRole(status: RuntimeRoleStatus, expectedRole?: string): void {
  if (expectedRole && status.role !== expectedRole) throw new Error(`Connected as ${status.role}; expected ${expectedRole}`);
  if (!status.canLogin) throw new Error(`PostgreSQL runtime role ${status.role} cannot log in`);
  if (status.superuser || status.bypassRls) throw new Error(`PostgreSQL runtime role ${status.role} can bypass row-level security`);
  if (!status.memberOfApplicationRole) throw new Error(`PostgreSQL runtime role ${status.role} cannot assume trestle_app`);
  if (status.memberOfPlatformRole) throw new Error(`PostgreSQL runtime role ${status.role} can assume trestle_platform; tenant runtimes must not hold platform authority`);
}

/** Grants trestle_platform to a distinct admin login that is never a tenant runtime role. */
export async function configurePlatformRole(connectionString: string, loginRole: string): Promise<PlatformRoleStatus> {
  const role = validateRoleName(loginRole);
  const sql = postgres(connectionString, { max: 1, prepare: false });
  try {
    const [record] = await sql<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; app_member: boolean }[]>`
      select rolcanlogin, rolsuper, rolbypassrls, pg_has_role(rolname, 'trestle_app', 'MEMBER') as app_member from pg_roles where rolname = ${role}
    `;
    if (!record) throw new Error(`PostgreSQL admin login role ${role} does not exist`);
    if (!record.rolcanlogin) throw new Error(`PostgreSQL admin login role ${role} cannot log in`);
    if (record.rolsuper || record.rolbypassrls) throw new Error(`PostgreSQL admin login role ${role} can bypass row-level security`);
    if (record.app_member) throw new Error(`PostgreSQL role ${role} is a tenant runtime role; the platform admin requires a distinct login`);
    await sql`grant trestle_platform to ${sql(role)}`;
    return { role, canLogin: true, superuser: false, bypassRls: false, memberOfPlatformRole: true, memberOfApplicationRole: false };
  } finally {
    await sql.end();
  }
}

export async function inspectPlatformRole(connectionString: string): Promise<PlatformRoleStatus> {
  const status = await inspectRuntimeRole(connectionString);
  return { role: status.role, canLogin: status.canLogin, superuser: status.superuser, bypassRls: status.bypassRls, memberOfPlatformRole: status.memberOfPlatformRole === true, memberOfApplicationRole: status.memberOfApplicationRole };
}

export function assertPlatformRole(status: PlatformRoleStatus, expectedRole?: string): void {
  if (expectedRole && status.role !== expectedRole) throw new Error(`Connected as ${status.role}; expected ${expectedRole}`);
  if (!status.canLogin) throw new Error(`PostgreSQL admin login role ${status.role} cannot log in`);
  if (status.superuser || status.bypassRls) throw new Error(`PostgreSQL admin login role ${status.role} can bypass row-level security`);
  if (!status.memberOfPlatformRole) throw new Error(`PostgreSQL admin login role ${status.role} cannot assume trestle_platform`);
  if (status.memberOfApplicationRole) throw new Error(`PostgreSQL admin login role ${status.role} is also a tenant runtime role`);
}

export async function verifyRuntimeRoleDataAccess(connectionString: string): Promise<void> {
  const sql = postgres(connectionString, { max: 1, prepare: false });
  try {
    const [access] = await sql<{ auth_read: boolean; receipt_write: boolean; tenant_read: boolean; webhook_read: boolean; message_read: boolean; delivery_read: boolean; attempt_read: boolean; secret_read: boolean; security_event_execute: boolean }[]>`
      select has_table_privilege(current_user, 'member', 'SELECT') as auth_read,
             has_table_privilege(current_user, 'billing_provider_event', 'INSERT') as receipt_write,
             has_table_privilege(current_user, 'tenant_record', 'SELECT') as tenant_read,
             has_table_privilege(current_user, 'webhook_endpoint', 'SELECT') as webhook_read,
             has_table_privilege(current_user, 'webhook_message', 'SELECT') as message_read,
             has_table_privilege(current_user, 'webhook_delivery', 'SELECT') as delivery_read,
             has_table_privilege(current_user, 'webhook_attempt', 'SELECT') as attempt_read,
             has_table_privilege(current_user, 'webhook_secret_version', 'SELECT') as secret_read,
             has_function_privilege(current_user, 'trestle_record_security_event(text, text, text, text)', 'EXECUTE') as security_event_execute
    `;
    if (!access?.auth_read || !access.receipt_write) throw new Error("Runtime login lacks required non-tenant table access");
    if (!access.security_event_execute) throw new Error("Runtime login cannot execute trestle_record_security_event");
    if (access.tenant_read || access.webhook_read || access.message_read || access.delivery_read || access.attempt_read || access.secret_read) throw new Error("Runtime login can read tenant records without assuming the RLS role");
    await sql`select id, application_role from member limit 0`;
    const url = new URL(connectionString);
    const existingOptions = url.searchParams.get("options");
    url.searchParams.set("options", [existingOptions, "-c role=trestle_app", "-c app.organization_id=trestle_role_probe"].filter(Boolean).join(" "));
    const tenantSql = postgres(url.toString(), { max: 1, prepare: false });
    try {
      const [scoped] = await tenantSql<{ role: string; organization_id: string }[]>`
        select current_user as role, current_setting('app.organization_id', true) as organization_id
          from tenant_record limit 1
      `;
      // An empty table must still prove the connection assumed the role.
      if (scoped && (scoped.role !== "trestle_app" || scoped.organization_id !== "trestle_role_probe")) throw new Error("Tenant role or context did not match the scoped connection");
      const [settings] = await tenantSql<{ role: string; organization_id: string }[]>`select current_user as role, current_setting('app.organization_id', true) as organization_id`;
      if (settings?.role !== "trestle_app" || settings.organization_id !== "trestle_role_probe") throw new Error("Tenant role or context did not match the scoped connection");
    } finally {
      await tenantSql.end();
    }
  } finally {
    await sql.end();
  }
}
