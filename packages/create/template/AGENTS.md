<!-- trestle:generated:start -->
# TrestleJS Application

This repository uses TrestleJS.

## Architecture

Astro public site → React and TanStack app → Hono → Application/Domain → Drizzle → PostgreSQL + RLS

## Rules

- Never accept tenant authority from clients.
- All tenant database operations use `withTenant()`.
- PostgreSQL RLS is mandatory and forced for tenant tables.
- Zod owns runtime boundaries; Drizzle owns persistence.
- Domain code does not import Hono or provider SDKs.
- Use `ctx.log`, never `console`, in application packages.
- Use `ctx.clock` for domain time.
- Queue payloads contain resource IDs, not tenant authority.
- Blobs belong in R2; Workflows own process progression; Durable Objects own coordination.
- `apps/site` is static-first public content; authentication stays in `apps/app`.
- Southwind source is application-owned. Replace its centralized identity rather than introducing a marketing runtime dependency.

## Discover and verify

```bash
trestle project --json
trestle plan validate .trestle/setup.json
trestle plan diff .trestle/setup.json
trestle resources --json
trestle routes --json
trestle doctor
trestle secrets check
pnpm check
```

Local secrets live only in encrypted `config/credentials.yml.enc`; never create
or commit plaintext `.env` or `.dev.vars` files. Use `trestle secrets edit` for
intentional human editing and `trestle secrets list` for non-revealing status.
<!-- trestle:generated:end -->

## Application-specific guidance

Add local guidance here. `trestle project sync` preserves this section.
