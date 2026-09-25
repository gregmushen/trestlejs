# Enable the optional platform admin

The admin is a separate React SPA and Hono Worker for **platform operations**.
It does not turn tenant administrators into platform operators, and it is not
a general-purpose global-resource generator. Product-specific workflows such
as crop editorial review remain application code.

## New projects

```bash
npx create-trestlejs@next my-app --admin
cd my-app
pnpm install
pnpm exec trestle doctor
```

`--admin` creates `apps/admin`, declares `apps.admin: apps/admin` and
`capabilities.admin: true`, and retains `DATABASE_ADMIN_URL` as an
admin-targeted encrypted-credentials declaration. The admin is optional and
off by default.

## Existing projects

Use the installed Trestle CLI version that contains admin enablement. The
project's generated template must be at that same version before adding the
admin; inspect `trestle upgrade diff`, review protected/customized files,
and complete the documented source upgrade first. No command overwrites an
existing `apps/admin` directory.

If `.trestle/setup.json` is absent, run `pnpm exec trestle plan init`.
Then edit it to declare both:

```json
"apps": { "site": true, "app": true, "worker": true, "admin": true },
"capabilities": { "r2": false, "queues": false, "workflows": false, "durableObjects": false, "admin": true }
```

Keep the other capability values appropriate to your project. Older plans
without `apps.admin` still parse; they derive its intent from
`capabilities.admin`. If both are present, they must agree. `plan init`
preserves secret declarations, including `DATABASE_ADMIN_URL` with
`target: admin` and optional secrets whose `required` list is empty.

```bash
pnpm exec trestle plan validate .trestle/setup.json
pnpm exec trestle plan diff .trestle/setup.json
pnpm exec trestle apply .trestle/setup.json --yes
pnpm install --frozen-lockfile
pnpm exec trestle doctor
pnpm check
```

`plan diff` must show `create apps.admin` and `create capabilities.admin`.
`apply` adds the admin source and manifest entry and refreshes the workspace
lockfile. It fails closed if the template version is stale or admin files
already exist. Turning admin off is a manual, potentially destructive
operation; `apply` will not delete it.

The generated files include `apps/admin` (SPA, Worker, view registry, and
tests) and `.trestle/project.yaml` capability/app entries. The deployment
workflow already contains conditional staging and production admin steps.
No remote resources, operators, or production secrets are created by
`apply`.

## Local and deployed configuration

| Surface | Local address |
| --- | --- |
| Admin SPA | `http://localhost:42070` |
| Admin API Worker | `http://localhost:8788` |

`pnpm --filter ./apps/admin dev` starts both locally. Remote staging and
production require `ADMIN_URL`, `ADMIN_API_URL`, and
`DATABASE_ADMIN_RUNTIME_ROLE` in their protected GitHub environments. The
admin Worker receives `DATABASE_ADMIN_URL` through Trestle encrypted
credentials and the explicitly shared auth secrets. Configure the platform
database login with only the `trestle_platform` role; the deployment workflow
verifies that role. Preview does not deploy the admin.

Create a regular user account first, enroll a second factor before deploying
an operator role, then grant a platform role through the separately
authorized migration credential:

```bash
pnpm exec trestle --experimental admin grant ops@example.com security_admin --env local --reason "first operator"
```

Replace the example address and choose the appropriate role. A platform role
does not confer organization or application permissions. Support sessions
grant bounded, audited access to a specific organization's information;
they never turn the operator into a tenant user.

`trestle doctor` checks the local admin scaffold and credential declaration
when admin is enabled. That is **not** hosted evidence. Deployment still
needs the admin smoke gate and an authenticated, authorized operator test.

## Application-owned modules

After enabling admin, generate a view shell under the existing admin
navigation and route registry:

```bash
pnpm exec trestle generate admin-module crop-editorial --permission platform.operations.read
pnpm --filter ./apps/admin check:views
```

Use an existing, registered **platform** permission that matches the
workflow. The generator creates `src/views/crop-editorial/` and adds a
server-registry entry with **no API routes**. Its page is a shell, not a crop
catalog or authorization implementation. These files and
`src/application-views.ts` are application-owned; upgrades must review any
conflicts rather than overwrite them.

To make the module functional, implement domain-specific Worker routes and
register each method/path and platform permission in
`apps/admin/src/application-views.ts`. The admin Worker must enforce that
permission. Mutations also require step-up, a reason, and a durable audit
record. Add tests for anonymous users, tenant-only users, cross-tenant
access, and action audit. The existing UI/Worker registry drift checks and
`check:views` catch incomplete registration, but navigation visibility alone
is never an authorization boundary.

## Maturity and limits

The generated admin shell, platform roles, audits, support sessions,
conditional deployment, and view registry exist. Enabling an existing
project is supported through reviewed SetupPlan/apply, but the hosted admin
path is still unverified in the beta testing ledger. The module generator
creates a guarded **view shell**; it does not generate a global catalog,
review/publication state machine, migrations, or provider operations. Those
remain application work. See [ADMIN_SPEC.md](ADMIN_SPEC.md) for the exact
implemented and deferred surface.
