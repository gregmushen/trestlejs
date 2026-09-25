# Admin Account Security Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators can enroll TOTP and passkeys, every session records how it was authenticated, and sensitive admin actions require recent, strong enough authentication (step-up).

**Architecture:** Better Auth's `twoFactor` and `@better-auth/passkey` plugins own the credential protocols. An `after` auth hook records per-session *assurance* (level, method, time) in `authentication_assurance`. The admin Worker loads the current session's assurance and, for every non-GET platform action, requires a level and freshness from `platformAssuranceRequirement`, returning HTTP 428 `step_up_required`; the restored `ConfirmAction` dialog already re-authenticates on 428. Local development accepts a fresh password, so `admin`/`admin` keeps working.

**Tech Stack:** Better Auth 1.7.5 (`better-auth/plugins` twoFactor, `@better-auth/passkey` 1.7.5), Drizzle, PostgreSQL, Hono, React + Kumo, Vitest.

**Reference implementation:** `origin/feat/regional-settings` — `packages/authz/src/assurance.ts`, `packages/auth/src/index.ts` (hooks, plugins), `packages/platform/src/authorization.ts` (`requireSensitive`), `apps/admin/src/views/account-security/`.

**Paths:** all paths below are under `packages/create/template/` unless they start with `docs/` or `scripts/`. Commands that name a generated project assume one generated with `--admin` from this worktree (see Task 0).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/authz/src/assurance.ts` (create) | Assurance levels, endpoint→assurance mapping, security-event names, `meetsRequirement`, `platformAssuranceRequirement` |
| `packages/authz/src/assurance.test.ts` (create) | Unit tests for the above |
| `packages/authz/src/index.ts` (modify) | Export assurance |
| `packages/db/src/auth-schema.ts` (modify) | `twoFactor`, `passkey` tables; `user.twoFactorEnabled` |
| `packages/db/src/assurance-schema.ts` (create) | `authentication_assurance` table |
| `packages/db/src/assurance.ts` (create) | `recordAssurance`, `sessionAssurance` |
| `packages/db/src/assurance.integration.test.ts` (create) | Round trip against PostgreSQL |
| `packages/db/src/index.ts` (modify) | Schema + exports |
| `packages/db/src/roles.ts` (modify) | Runtime login grants for `two_factor`, `passkey`, `authentication_assurance`, and execute on `trestle_record_security_event` |
| `packages/db/migrations/0032_*.sql` (generated + hand-written) | Tables; `trestle_record_security_event` SECURITY DEFINER function |
| `packages/auth/package.json` (modify) | `@better-auth/passkey` |
| `packages/auth/src/index.ts` (modify) | `factors` option (admin only), plugins, assurance hook, security audit events |
| `apps/admin/worker/index.ts` (modify) | Expose 2FA/passkey auth routes, load assurance, enforce step-up, report assurance in session |
| `apps/admin/worker/route-policies.ts` (modify) | Public policies for the new auth routes |
| `apps/admin/worker/index.test.ts` (modify) | Step-up tests |
| `apps/admin/src/auth-client.ts` (modify) | `passkeyClient`, real `reauthenticateWithPasskey` |
| `apps/admin/src/main-backend.ts` (modify) | Map `assurance`/`stepUpRequiredAfter` from the session |
| `apps/admin/src/views/account-security/*` (create) | Enrollment screen (ported) |
| `apps/admin/src/api-registry.ts` (modify) | `account-security` view entry |
| `apps/admin/package.json` (modify) | `@better-auth/passkey` |
| `docs/ADMIN_SPEC.md` (modify) | Account security and step-up, no longer deferred |

---

### Task 0: Branch and dev project

- [ ] **Step 1: Branch from the latest main**

```bash
cd /Users/gregmushen/work/code/gstack && git fetch origin
git worktree add -b feat/admin-account-security ../gstack-admin-security origin/main
```

If `feat/admin-ui-restore` has not merged yet, branch from it instead (`origin/feat/admin-ui-restore`); this plan depends on the restored admin UI.

- [ ] **Step 2: Build and generate an admin dev project**

```bash
cd ../gstack-admin-security && pnpm install --frozen-lockfile && pnpm build
node packages/create/dist/bin.js /tmp/admin-sec/app --no-git --no-install --admin
```

Link the generated project to this worktree's CLI (`devDependencies.trestlejs = "link:<worktree>/packages/cli"`, `pnpm.overrides["@trestlejs/core"] = "link:<worktree>/packages/core"`), then `pnpm install`. Sync template edits into it with placeholder substitution (`__TRESTLE_PROJECT_NAME__` → the project name) before each test run.

---

### Task 1: Assurance policy in authz

**Files:**
- Create: `packages/authz/src/assurance.ts`
- Create: `packages/authz/src/assurance.test.ts`
- Modify: `packages/authz/src/index.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/authz/src/assurance.test.ts
import { describe, expect, it } from "vitest";

import { assuranceForEndpoint, meetsRequirement, platformAssuranceRequirement, securityEventForEndpoint } from "./assurance.js";

const now = new Date("2026-09-23T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("authentication assurance", () => {
  it("derives what a new session proves from the endpoint that created it", () => {
    expect(assuranceForEndpoint("/sign-in/email")).toEqual({ level: "password", method: "password" });
    expect(assuranceForEndpoint("/two-factor/verify-totp")).toEqual({ level: "mfa", method: "totp" });
    expect(assuranceForEndpoint("/two-factor/verify-backup-code")).toEqual({ level: "mfa", method: "backup_code" });
    expect(assuranceForEndpoint("/passkey/verify-authentication")).toEqual({ level: "phishing_resistant", method: "passkey" });
  });

  it("requires the level and freshness, and says why it fails", () => {
    const requirement = { level: "mfa" as const, maxAgeMinutes: 15 };
    expect(meetsRequirement(null, requirement, now)).toEqual({ ok: false, reason: "missing" });
    expect(meetsRequirement({ sessionId: "s", level: "password", method: "password", verifiedAt: minutesAgo(1) }, requirement, now)).toEqual({ ok: false, reason: "insufficient_level" });
    expect(meetsRequirement({ sessionId: "s", level: "mfa", method: "totp", verifiedAt: minutesAgo(16) }, requirement, now)).toEqual({ ok: false, reason: "stale" });
    expect(meetsRequirement({ sessionId: "s", level: "phishing_resistant", method: "passkey", verifiedAt: minutesAgo(1) }, requirement, now)).toEqual({ ok: true });
  });

  it("accepts a fresh password locally and requires factors when deployed", () => {
    expect(platformAssuranceRequirement("platform.outbox.redrive", "local")).toEqual({ level: "password", maxAgeMinutes: 15 });
    expect(platformAssuranceRequirement("platform.outbox.redrive", "production")).toEqual({ level: "mfa", maxAgeMinutes: 15 });
    expect(platformAssuranceRequirement("platform.roles.manage", "staging")).toEqual({ level: "phishing_resistant", maxAgeMinutes: 15 });
  });

  it("names audited account-security changes without credential material", () => {
    expect(securityEventForEndpoint("/two-factor/disable")).toBe("security.two_factor.disabled");
    expect(securityEventForEndpoint("/passkey/verify-registration")).toBe("security.passkey.added");
    expect(securityEventForEndpoint("/sign-in/email")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /tmp/admin-sec/app/packages/authz && pnpm exec vitest run src/assurance.test.ts`
Expected: FAIL, cannot resolve `./assurance.js`.

- [ ] **Step 3: Implement**

Copy `origin/feat/regional-settings:packages/create/template/packages/authz/src/assurance.ts` and make two changes: add the `ApplicationEnvironment` import from `./api-keys.js` (it already defines `"local" | "preview" | "staging" | "production"`) for the `environment` parameter, and set the phishing-resistant permissions to the codes `main` registers:

```ts
const phishingResistantPermissions: ReadonlySet<string> = new Set(["platform.roles.manage"]);
```

Steps 2–8 of the roadmap add their own codes to this set when they introduce them (for example the secrets and authentication-policy permissions in step 3).

Then export it: add `export * from "./assurance.js";` to `packages/authz/src/index.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run src/assurance.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/create/template/packages/authz/src/assurance.ts packages/create/template/packages/authz/src/assurance.test.ts packages/create/template/packages/authz/src/index.ts
git commit -m "Add authentication assurance policy for platform step-up"
```

---

### Task 2: Schema and migration

**Files:**
- Modify: `packages/db/src/auth-schema.ts`
- Create: `packages/db/src/assurance-schema.ts`
- Modify: `packages/db/src/index.ts`
- Create: `packages/db/migrations/0032_*.sql` (generated) and its snapshot/journal

- [ ] **Step 1: Add the Better Auth plugin tables**

In `auth-schema.ts`, add `twoFactorEnabled: boolean("two_factor_enabled").default(false)` to `user`, and add these tables (column names match the plugins' expected fields; copy from `origin/feat/regional-settings:packages/create/template/packages/db/src/auth-schema.ts`):

```ts
export const twoFactor = pgTable("two_factor", {
  id: text("id").primaryKey(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  verified: boolean("verified").default(true),
  failedVerificationCount: integer("failed_verification_count").default(0),
  lockedUntil: timestamp("locked_until"),
}, (table) => [index("two_factor_secret_idx").on(table.secret), index("two_factor_user_id_idx").on(table.userId)]);

export const passkey = pgTable("passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  credentialID: text("credential_id").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text("transports"),
  createdAt: timestamp("created_at"),
  aaguid: text("aaguid"),
}, (table) => [index("passkey_user_id_idx").on(table.userId), index("passkey_credential_id_idx").on(table.credentialID)]);
```

- [ ] **Step 2: Add the assurance table**

```ts
// packages/db/src/assurance-schema.ts
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { session } from "./auth-schema.js";

/**
 * How each session was authenticated and when. Written by the auth hook when
 * Better Auth creates a session; read by the admin Worker to enforce step-up.
 * It holds no credential material.
 */
export const authenticationAssurance = pgTable("authentication_assurance", {
  sessionId: text("session_id").primaryKey().references(() => session.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  level: text("level").notNull(),
  method: text("method").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
}, (table) => [index("authentication_assurance_user_idx").on(table.userId)]);
```

Register it in `packages/db/src/index.ts` next to the other schemas (`import * as assuranceSchema from "./assurance-schema.js";`, add it to the schema object, and `export * from "./assurance-schema.js";`).

- [ ] **Step 3: Generate the migration**

Run: `cd /tmp/admin-sec/app/packages/db && DATABASE_URL=postgres://unused pnpm db:generate`
Expected: one new file `migrations/0032_<name>.sql` creating `two_factor`, `passkey`, `authentication_assurance` and adding `user.two_factor_enabled`. If it also drops or alters tables you did not touch, the dev project is stale: regenerate it (Task 0, Step 2) and repeat.

- [ ] **Step 4: Append the security-event function**

Security events have no organization, so neither the tenant role nor the runtime login may insert them directly: a policy `TO PUBLIC` would also let tenant code running as `trestle_app` (which already has `INSERT` on `audit_event`, migration 0021) forge organization-less rows for any user. Instead, one `SECURITY DEFINER` function writes exactly one shape of row, and only the runtime login may execute it (granted per install in Task 3). Append to the generated SQL, keeping the `--> statement-breakpoint` separator after the last generated statement:

```sql
--> statement-breakpoint
-- Account-security events: organization-less, actor and target are the same user, fixed outcome.
-- The runtime login may name any user: it already writes user and session rows, so this grants it nothing new.
-- Executable only by the runtime login (granted in configureRuntimeRole); never by trestle_app.
CREATE OR REPLACE FUNCTION trestle_record_security_event(p_name text, p_user_id text, p_correlation_id text, p_environment text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.audit_event (name, schema_version, actor_type, actor_id, organization_id, target_type, target_id, summary, outcome, environment, correlation_id)
  SELECT p_name, '1', 'user', p_user_id, NULL, 'user', p_user_id, '{}'::jsonb, 'succeeded', p_environment, p_correlation_id
   WHERE p_name ~ '^security\.[a-z_]+\.[a-z_]+$'
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION trestle_record_security_event(text, text, text, text) FROM PUBLIC;--> statement-breakpoint
-- audit_event forces RLS; the function owner needs an insert policy unless it bypasses RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    EXECUTE format('CREATE POLICY "audit_event_security_owner" ON "audit_event" FOR INSERT TO %I WITH CHECK (organization_id IS NULL AND name LIKE %L)', current_user, 'security.%');
  END IF;
END
$$;
```

Check `audit_event.schema_version`'s column type in `audit-schema.ts` (text today) and match the literal. This is hand-written SQL outside the Drizzle snapshot; add a comment at the top of `audit-schema.ts` pointing to this migration so the next reader knows the function exists.

- [ ] **Step 5: Copy the migration into the template and commit**

Copy `0032_<name>.sql`, `meta/0032_snapshot.json`, and `meta/_journal.json` from the generated project to `packages/db/migrations/`.

```bash
git add packages/create/template/packages/db
git commit -m "Add two-factor, passkey, and authentication assurance tables"
```

---

### Task 3: Runtime login grants

**Files:**
- Modify: `packages/db/src/roles.ts:75` (the `for (const table of [...])` grant list) and `verifyRuntimeRoleDataAccess` (add `has_function_privilege(current_user, 'trestle_record_security_event(text, text, text, text)', 'EXECUTE')` to its checks so deployed Doctor verification catches a missing grant)
- Modify: `packages/db/src/roles.integration.test.ts`

- [ ] **Step 1: Write the failing assertions**

In `roles.integration.test.ts` (it owns runtime-login grants; `platform-roles.integration.test.ts` owns the platform role), in the test that configures the runtime role, add:

```ts
const [grants] = await admin!<{ two_factor: boolean; passkey: boolean; assurance: boolean; security_event: boolean; audit_insert: boolean; tenant_security_event: boolean }[]>`
  select has_table_privilege(${runtimeRole}, 'two_factor', 'SELECT,INSERT,UPDATE,DELETE') as two_factor,
         has_table_privilege(${runtimeRole}, 'passkey', 'SELECT,INSERT,UPDATE,DELETE') as passkey,
         has_table_privilege(${runtimeRole}, 'authentication_assurance', 'SELECT,INSERT,UPDATE') as assurance,
         has_function_privilege(${runtimeRole}, 'trestle_record_security_event(text, text, text, text)', 'EXECUTE') as security_event,
         has_table_privilege(${runtimeRole}, 'audit_event', 'INSERT') as audit_insert,
         has_function_privilege('trestle_app', 'trestle_record_security_event(text, text, text, text)', 'EXECUTE') as tenant_security_event`;
// The login records security events only through the function; tenant code cannot call it at all.
expect(grants).toEqual({ two_factor: true, passkey: true, assurance: true, security_event: true, audit_insert: false, tenant_security_event: false });
```

- [ ] **Step 2: Run to verify it fails**

Run: `TRESTLE_RLS_TEST_DATABASE_URL=<migrated db> pnpm exec vitest run src/roles.integration.test.ts`
Expected: FAIL, the privileges are false.

- [ ] **Step 3: Grant them**

Add `"two_factor", "passkey"` to the grant list at `roles.ts:75`, and after the loop:

```ts
// Session assurance is written by the auth hook and read by the admin Worker.
await sql`grant select, insert, update on authentication_assurance to ${sql(role)}`;
// Account-security events go through the SECURITY DEFINER function, never a direct audit_event insert.
await sql`grant execute on function trestle_record_security_event(text, text, text, text) to ${sql(role)}`;
```

- [ ] **Step 4: Run to verify it passes**, then **Step 5: Commit** (`git commit -m "Grant the runtime login two-factor, passkey, and assurance tables"`).

---

### Task 4: Record assurance and security events in auth

**Files:**
- Modify: `packages/auth/package.json` (add `"@better-auth/passkey": "1.7.5"`)
- Modify: `packages/auth/src/index.ts`
- Create: `packages/db/src/assurance.ts`, `packages/db/src/assurance.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// packages/db/src/assurance.integration.test.ts
import { describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createDatabase, session, user } from "./index.js";
import { recordAssurance, sessionAssurance } from "./assurance.js";

const url = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("session assurance", () => {
  it("records, upgrades, and cascades how a session was authenticated", async () => {
    const database = createDatabase(url!, "postgres-js");
    const run = crypto.randomUUID();
    const userId = `assurance-user-${run}`;
    const sessionId = `assurance-session-${run}`;
    const now = new Date();
    await database.insert(user).values({ id: userId, name: "Assurance", email: `${userId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    await database.insert(session).values({ id: sessionId, userId, token: `token-${run}`, expiresAt: new Date(now.getTime() + 3_600_000), createdAt: now, updatedAt: now });
    try {
      await recordAssurance(database, { sessionId, userId, level: "password", method: "password" });
      expect(await sessionAssurance(database, sessionId)).toMatchObject({ sessionId, level: "password", method: "password" });
      await recordAssurance(database, { sessionId, userId, level: "mfa", method: "totp" });
      expect(await sessionAssurance(database, sessionId)).toMatchObject({ level: "mfa", method: "totp" });
      expect(await sessionAssurance(database, "missing")).toBeNull();
      // Assurance never outlives its session.
      await database.delete(session).where(eq(session.id, sessionId));
      expect(await sessionAssurance(database, sessionId)).toBeNull();
    } finally {
      await database.delete(user).where(eq(user.id, userId));
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails** (module not found).

- [ ] **Step 3: Implement the repository**

```ts
// packages/db/src/assurance.ts
import { eq, sql } from "drizzle-orm";

import { authenticationAssurance } from "./assurance-schema.js";
import type { Database } from "./index.js";

export type SessionAssurance = Readonly<{ sessionId: string; userId: string; level: "password" | "mfa" | "phishing_resistant"; method: string; verifiedAt: Date }>;

export async function recordAssurance(database: Pick<Database, "insert">, input: Readonly<{ sessionId: string; userId: string; level: SessionAssurance["level"]; method: string }>): Promise<void> {
  await database.insert(authenticationAssurance).values({ ...input, verifiedAt: new Date() })
    .onConflictDoUpdate({ target: authenticationAssurance.sessionId, set: { level: input.level, method: input.method, verifiedAt: sql`now()` } });
}

export async function sessionAssurance(database: Pick<Database, "select">, sessionId: string): Promise<SessionAssurance | null> {
  const [row] = await database.select().from(authenticationAssurance).where(eq(authenticationAssurance.sessionId, sessionId)).limit(1);
  return row ? { ...row, level: row.level as SessionAssurance["level"] } : null;
}
```

Export from `packages/db/src/index.ts`. Run the test: PASS.

- [ ] **Step 4: Add an options argument so only the admin enables factors**

`createAuth` is shared with `apps/worker`, which mounts `/api/auth/*` wholesale (`apps/worker/src/index.ts`, the `app.on(["GET", "POST"], "/api/auth/*", ...)` route). Customer 2FA and passkeys belong to roadmap step 3 (authentication policy), so this step enables them for operators only:

```ts
export type AuthOptions = Readonly<{ factors?: boolean }>;
export function createAuth(environment: AuthEnvironment, options: AuthOptions = {}) {
```

In `apps/admin/worker/index.ts`, `adminAuth` passes `{ factors: true }`. The customer Worker keeps calling `createAuth(environment)` unchanged. Assurance is still recorded for customer sessions (the hook runs regardless) so step 3 can require it.

- [ ] **Step 5: Wire the plugins and the hook in `createAuth`**

Add imports (`twoFactor` from `better-auth/plugins`, `passkey` from `@better-auth/passkey`, `createAuthMiddleware` from `better-auth/api`, `assuranceForEndpoint`/`securityEventForEndpoint` from authz, `recordAssurance`/`recordAuditEvent` from db). Then, in the `betterAuth({ ... })` options:

```ts
hooks: {
  // Record how each new session was authenticated, and audit account-security changes.
  after: createAuthMiddleware(async (context) => {
    const created = context.context.newSession;
    const event = securityEventForEndpoint(context.path);
    // Most auth requests (get-session, sign-out) write nothing; open a connection only when needed.
    if (!created && !event) return;
    const database = createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER);
    if (created) await recordAssurance(database, { sessionId: created.session.id, userId: created.user.id, ...assuranceForEndpoint(context.path) });
    const actor = context.context.session?.user.id ?? created?.user.id;
    const returned = context.context.returned as { status?: number } | undefined;
    if (event && actor && !(returned instanceof Error) && (returned?.status ?? 200) < 400) await recordSecurityEvent(environment, event, actor);
  }),
},
databaseHooks: {
  user: {
    update: {
      // Enrollment completes when the first code verifies; sign-in challenges never update the user.
      after: async (user, context) => {
        if (context?.path.startsWith("/two-factor/verify-") && (user as { twoFactorEnabled?: boolean }).twoFactorEnabled) await recordSecurityEvent(environment, "security.two_factor.enabled", user.id);
      },
    },
  },
},
```

with this helper below `createAuth`. The credential change has already committed when the hook runs, so a failed audit write is logged rather than failing the request (the operator's change happened; returning 500 would misreport it):

```ts
/** Records an organization-less security.* event through the SECURITY DEFINER function (migration 0032). */
async function recordSecurityEvent(environment: AuthEnvironment, name: string, userId: string): Promise<void> {
  try {
    await createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER)
      .execute(sql`select trestle_record_security_event(${name}, ${userId}, ${`auth:${crypto.randomUUID()}`}, ${environment.APP_ENV ?? "local"})`);
  } catch (error) {
    createLogger({ surface: "auth" }).error("security.audit.record_failed", { event: name, errorName: error instanceof Error ? error.name : "unknown" });
  }
}
```

(`sql` from `drizzle-orm`, `createLogger` from `@__TRESTLE_PROJECT_NAME__/context`; add `@__TRESTLE_PROJECT_NAME__/context` to `packages/auth/package.json` if it is not already a dependency.) Drop the `recordAuditEvent` import; the auth package never inserts `audit_event` directly.

Append to `plugins` (after `organization(...)`), gated by the option:

```ts
...(options.factors ? [
  // Passkeys (WebAuthn) bound to the origin serving this auth instance.
  passkey({ rpID: new URL(webOrigin).hostname, rpName: "__TRESTLE_PROJECT_NAME__", origin: webOrigin }),
  // TOTP and backup codes; Better Auth encrypts the secret and codes at rest.
  twoFactor({ issuer: "__TRESTLE_PROJECT_NAME__" }),
] : []),
```

Note on ordering: user `after` hooks run before plugin hooks, so a password sign-in by a 2FA-enabled operator records `password` assurance for a session the two-factor plugin then deletes. The row disappears with that session through the foreign key Task 2 declares (`on delete cascade`).

- [ ] **Step 6: Typecheck, then verify a real sign-in records assurance**

Run in the dev project: `pnpm -r typecheck` (expect clean), then start PostgreSQL and the Worker, sign in with `curl -X POST localhost:8787/api/auth/sign-in/email ...`, and query `select level, method from authentication_assurance order by verified_at desc limit 1` — expect `password | password`.

- [ ] **Step 7: Add the negative test and commit**

In `packages/db/src/assurance.integration.test.ts`, add a test that opens a transaction with `postgres(url).begin(...)` (the RLS test connection may assume `trestle_app`; `set local role` only lasts inside a transaction) and, running as `trestle_app` (`set local role trestle_app`), `select trestle_record_security_event('security.x.y', 'u', 'c', 'local')` fails with `permission denied`, and a direct `insert into audit_event (...) values (... organization_id null, name 'security.x.y' ...)` fails. Then:

`git commit -m "Record session assurance and account-security events; enable TOTP and passkeys for operators"`.

---

### Task 5: Step-up in the admin Worker

**Files:**
- Modify: `apps/admin/worker/index.ts` (middleware at "Platform authentication and authority for every admin API route", the `/api/admin/session` route, and the auth route list)
- Modify: `apps/admin/worker/route-policies.ts` (`basePolicies`)
- Modify: `apps/admin/worker/index.test.ts`

- [ ] **Step 1: Write the failing tests**

In `index.test.ts` the Worker's dependencies are replaceable through `adminDependencies`, the environment is the module-level `environment` constant (`APP_ENV: "local"`), the signed-in user is `state.userId`, and `call(method, path, init?)` sends requests. Before writing the test:

1. Give `call` an optional environment override (`call(method, path, init = {}, env = environment)`) so a test can use `{ ...environment, APP_ENV: "production" }`.
2. In the mocked `adminDependencies.session`, return `{ user: {...}, session: { id: "session-1" } }` — after Task 5 widens `Session`, every test needs `session.id`.
3. In `beforeEach`, set `adminDependencies.assurance` to a fresh local password assurance so existing action tests keep passing.

Then add:

```ts
it("requires fresh assurance for platform actions and reports it in the session", async () => {
  adminDependencies.assurance = async () => ({ sessionId: "session-1", userId: state.userId, level: "password", method: "password", verifiedAt: new Date(Date.now() - 20 * 60_000) });
  const stale = await call("POST", "/api/admin/operations/outbox/evt-1/redrive", { body: { reason: "retry" } });
  expect(stale.status).toBe(428);
  expect(stale.body).toMatchObject({ error: "step_up_required", required: "password", reason: "stale" });

  adminDependencies.assurance = async () => ({ sessionId: "session-1", userId: state.userId, level: "password", method: "password", verifiedAt: new Date() });
  const production = await call("POST", "/api/admin/operations/outbox/evt-1/redrive", { body: { reason: "retry" } }, { ...environment, APP_ENV: "production", DATABASE_ADMIN_URL: environment.DATABASE_URL });
  expect(production.status).toBe(428);
  expect(production.body).toMatchObject({ required: "mfa", reason: "insufficient_level" });

  const session = await call("GET", "/api/admin/session");
  expect(session.body.assurance).toMatchObject({ level: "password", method: "password" });
  expect(Date.parse(session.body.stepUpRequiredAfter)).toBeGreaterThan(Date.now());
});
```

Read the current `call`, `state`, and `beforeEach` in the file first and adapt the setup, not the assertions.

- [ ] **Step 2: Run to verify it fails** (`pnpm exec vitest run worker/index.test.ts`; expect 200/404 instead of 428).

- [ ] **Step 3: Implement**

1. Add to `adminDependencies`:

```ts
assurance: async (environment: AdminEnvironment, sessionId: string) => await sessionAssurance(createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER), sessionId),
```

widen `Session` to `{ user: {...}; session: { id: string } }`, and add `assurance: SessionAssurance | null` to the `Variables` type so `context.set("assurance", ...)` typechecks.

2. In the authority middleware, after `access.require(...)`, for any non-GET route with a permission:

```ts
const assurance = await adminDependencies.assurance(context.env, session.session.id);
context.set("assurance", assurance);
if (context.req.method !== "GET" && policy.permission) {
  const requirement = platformAssuranceRequirement(policy.permission, context.env.APP_ENV ?? "local");
  const result = meetsRequirement(assurance, requirement, new Date());
  if (!result.ok) return context.json({ error: "step_up_required", required: requirement.level, maxAgeMinutes: requirement.maxAgeMinutes, reason: result.reason, message: `Re-authenticate ${requirement.level === "phishing_resistant" ? "with a passkey" : requirement.level === "mfa" ? "with a second factor" : "with your password"} to perform this action` }, 428);
}
```

3. In `/api/admin/session`, add:

```ts
assurance: assurance ? { level: assurance.level, method: assurance.method, verifiedAt: assurance.verifiedAt.toISOString() } : null,
stepUpRequiredAfter: new Date((assurance?.verifiedAt.getTime() ?? 0) + 15 * 60_000).toISOString(),
```

4. Expose the factor endpoints on the admin origin: extend the auth route loop and `basePolicies` with `POST /api/auth/two-factor/enable`, `/two-factor/disable`, `/two-factor/verify-totp`, `/two-factor/verify-backup-code`, `/two-factor/generate-backup-codes`, `GET /api/auth/passkey/list-user-passkeys`, `GET /api/auth/passkey/generate-register-options`, `POST /api/auth/passkey/verify-registration`, `GET /api/auth/passkey/generate-authenticate-options`, `POST /api/auth/passkey/verify-authentication`, `POST /api/auth/passkey/delete-passkey` (all `public: true, audience: "public"`: Better Auth authenticates them itself). Check exact method/path pairs against `better-auth` 1.7.5's plugin endpoint definitions before adding them.

- [ ] **Step 3b: Step-up for factor management**

Better Auth's factor endpoints (`/two-factor/enable`, `/two-factor/disable`, `/two-factor/generate-backup-codes`, `/passkey/generate-register-options`, `/passkey/verify-registration`, `/passkey/delete-passkey`) require only a password or a session. Without a gate, someone holding only the password could replace an operator's factors and then sign in at a higher level. The same holds one level up: someone with the password and a phished TOTP code could register their own passkey, sign in with it as `phishing_resistant`, and use `platform.roles.manage`, or delete the real passkeys. In the admin Worker, before forwarding any of these to Better Auth:

1. Resolve the session (`adminDependencies.session`); no session → 401.
2. Restrict the endpoints to platform operators: apply the admin middleware's local-account rule (the seeded `admin@trestle.local` account gets 403 `local_account` outside local development), then return 403 `no_platform_roles` when `adminDependencies.platformRoles` is empty.
3. Require the strongest factor the account already has, fresh within `stepUpWindowMinutes` (15), in every environment. `adminDependencies.enrolledFactor` returns `"phishing_resistant"` when any `passkey` row exists, `"mfa"` when `user.two_factor_enabled` is set, and `null` otherwise, read through one auth-database handle shared with the assurance lookup. With no factor yet (first enrollment), require a fresh password. An operator with only TOTP can still add a first passkey with fresh `mfa`.
4. Otherwise respond 428 `step_up_required` with the same body shape as Step 3.

The other factor endpoints on the admin origin:
- `GET /passkey/list-user-passkeys`: operator check only; a read needs no step-up.
- `POST /two-factor/verify-totp` with a session (completing enrollment, whose enable step was already stepped up): operator check only. Without a session it is a sign-in or step-up challenge and stays open.
- `verify-backup-code`, `generate-authenticate-options`, `verify-authentication`: open, because sign-in needs them.

Add tests:
- a table over the six gated paths: insufficient evidence gets 428, sufficient evidence is forwarded, at each enrolled level (none → password, TOTP → mfa, passkey → phishing_resistant);
- an operator with a passkey and fresh mfa gets 428 `required: "phishing_resistant"`;
- an operator with only TOTP and fresh mfa can register a first passkey;
- a signed-in non-operator gets 403 on enable and generate-register-options;
- the seeded local account gets 403 outside local development.

- [ ] **Step 4: Run to verify it passes**, plus the whole admin suite (`pnpm exec vitest run`); the `beforeEach` fixture from Step 1 keeps the existing action tests passing.

- [ ] **Step 5: Commit** (`git commit -m "Require step-up assurance for platform actions"`).

---

### Task 6: Admin UI

**Files:**
- Modify: `apps/admin/package.json` (`"@better-auth/passkey": "1.7.5"`), `apps/admin/src/auth-client.ts`, `apps/admin/src/main-backend.ts`, `apps/admin/src/api-registry.ts`, `apps/admin/src/api-registry.test.ts`
- Create: `apps/admin/src/views/account-security/admin-view.ts`, `view.tsx`

- [ ] **Step 1: Restore the passkey client**

In `auth-client.ts`, add `import { passkeyClient } from "@better-auth/passkey/client";`, include `passkeyClient()` in `plugins`, and replace the stub:

```ts
export async function reauthenticateWithPasskey(): Promise<ReauthResult> {
  const result = await authClient().signIn.passkey();
  return result?.error ? { ok: false, error: result.error.message ?? "Passkey verification failed" } : { ok: true };
}
```

Restore the "Sign in with a passkey" button in `main.tsx`'s `SignIn` (it is in the branch version of the file).

- [ ] **Step 2: Map real assurance in `main-backend.ts`**

In `session()`, replace the placeholders with the Worker's values:

```ts
stepUpRequiredAfter: wire.stepUpRequiredAfter,
assurance: wire.assurance,
```

and add `stepUpRequiredAfter: string; assurance: AdminSession["assurance"]` to `WireSession`.

- [ ] **Step 3: Port the Account security view**

Copy `origin/feat/regional-settings:.../apps/admin/src/views/account-security/{admin-view.ts,view.tsx}`. In the descriptor use `permission: "platform.overview.read"` (every operator manages their own factors) and `path: "/account/security"`. Add the matching server registry entry with `api: []` (the view talks to Better Auth, not the admin API) and add `"account-security"` to the id list in `api-registry.test.ts`.

- [ ] **Step 4: Verify in the browser**

With the dev stack running, sign in as `admin`/`admin`, open Account security, enroll TOTP with a test authenticator (or compute the code from the displayed secret with `otplib`), sign out, sign in again: the second step asks for a code, and after it `select level from authentication_assurance order by verified_at desc limit 1` returns `mfa`. Wait 16 minutes (or set the row's `verified_at` back) and trigger a redrive: the confirmation dialog asks you to re-authenticate.

- [ ] **Step 5: Run `pnpm check:views` and the admin tests; commit** (`git commit -m "Restore operator account security: TOTP, passkeys, and step-up"`).

---

### Task 7: Canary, docs, PR

- [ ] **Step 1:** Add `"requires fresh assurance for platform actions and reports it in the session"` to the admin `requireScenarios` list in `scripts/check-generated-project.mjs`.
- [ ] **Step 2:** In `docs/ADMIN_SPEC.md`, replace the "Deferred: step-up authentication" notes (§7.5 and §15) with the shipped behavior: per-session assurance, the local/deployed/phishing-resistant requirement table, and 428 `step_up_required`.
- [ ] **Step 3:** Run `pnpm check` and `TRESTLE_GENERATED_DATABASE_URL=<fresh db> node scripts/check-generated-project.mjs`; both must pass.
- [ ] **Step 4:** Commit, push, and open the PR against `main` with the evidence in its description.
