import postgres from "postgres";

export type RuntimeRoleStatus = {
  role: string;
  canLogin: boolean;
  superuser: boolean;
  bypassRls: boolean;
  memberOfApplicationRole: boolean;
};

function validateRoleName(role: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/u.test(role)) throw new Error("Invalid PostgreSQL runtime role name");
  if (role === "trestle_app") throw new Error("The runtime login role must be distinct from trestle_app");
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
    await sql`grant trestle_app to ${sql(role)}`;
    return {
      role,
      canLogin: record.rolcanlogin,
      superuser: record.rolsuper,
      bypassRls: record.rolbypassrls,
      memberOfApplicationRole: true,
    };
  } finally {
    await sql.end();
  }
}

export async function inspectRuntimeRole(connectionString: string): Promise<RuntimeRoleStatus> {
  const sql = postgres(connectionString, { max: 1, prepare: false });
  try {
    const [record] = await sql<{ role: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; app_member: boolean }[]>`
      select current_user as role,
             rolcanlogin,
             rolsuper,
             rolbypassrls,
             pg_has_role(current_user, 'trestle_app', 'MEMBER') as app_member
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
}
