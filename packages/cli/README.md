# trestlejs

The command-line interface for building and operating conventional TrestleJS
applications.

```bash
npm install --global trestlejs
trestle --help
```

To create a new application, use:

```bash
npx create-trestlejs my-app
```

Core architecture and setup commands include:

```bash
trestle plan init
trestle plan validate .trestle/setup.json
trestle plan diff .trestle/setup.json
trestle apply .trestle/setup.json --yes
trestle generate resource Article
trestle resources --json
trestle routes --json
trestle doctor
trestle email doctor --env staging
trestle --experimental payments stripe sync --env staging
trestle logs --env staging --status error
```

Infrastructure lifecycle through Stripe Projects is experimental and separate
from customer billing:

```bash
trestle --experimental infra catalog neon
trestle --experimental infra plan --env staging
trestle --experimental infra doctor --env staging
```

Remote changes need an independent PostgreSQL control store, a signed approval
and verified provider evidence; see
[docs/STRIPE_PROJECTS.md](https://github.com/gregmushen/trestlejs/blob/main/docs/STRIPE_PROJECTS.md).

### Stripe Projects behavior to know

Observed with Stripe Projects plugin 0.45.0 (2026-10-02). `trestle infra`
protects against each of these, but they matter if you run `stripe projects`
yourself:

- **`add` is not idempotent.** Running `stripe projects add` twice with the same
  `--name` silently creates a second resource named `<name>-2`. Never retry a
  timed-out `add`. `trestle infra apply` journals intent, reconciles by
  observation instead of retrying, and refuses to create when the name or a
  `<name>-N` sibling already exists; pass `--allow-duplicate <reason> --actor
  <name>` only when a second resource is intended (the override is journaled).
- **Linking can create provider accounts.** `stripe projects link neon
  --accept-tos` created a new Neon account without any browser step.
- **The Neon connection string is the database owner.** It connects as
  `neondb_owner`, which has `BYPASSRLS` and `CREATEROLE`, so row-level security
  does not apply to it. Keep it operator-only and give Workers a derived
  least-privilege runtime role.
- **Plaintext credentials are written automatically.** `add`, `rotate`,
  `remove` and environment changes rewrite the active `.env*` output file, and can
  rename existing variables (`NEON_ORG_ID` became `NEON_PLAN_ORG_ID`). Variables are
  prefixed by the resource name (`DATABASE_CONNECTION_STRING`, not `DATABASE_URL`).
- **Rotation invalidates immediately, except for open connections.** After
  `rotate`, new connections with the old Neon password fail (`28P01`), but
  already-open pooled connections keep working until they reconnect.
- **`remove` takes a name, not an ID, and deprovisions the resource.** It is not a
  detach. `unlink` removes the provider connection but not the provider account,
  and there is no command to delete a Projects project.
- **Live mode is required.** Projects refuses a test-mode CLI context, and a new
  account must enable Projects in the Stripe Dashboard before `init` works.

`trestle logs` displays a bounded projection of Trestle semantic events, not
raw Cloudflare requests, exception text, or arbitrary console output.

See the [TrestleJS repository](https://github.com/gregmushen/trestlejs) for
documentation and source code.
