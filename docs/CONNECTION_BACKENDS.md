# Connection backends

A tenant **Connection** binds one organization to one external account (for
example, a customer's GitHub or Slack). A connection backend holds the
provider credentials, runs the provider authorization flow, refreshes tokens,
and makes authenticated provider calls. Trestle still owns the Connection
itself: its tenant binding, lifecycle state, generation, permissions, and
audit. See §8.3 of [INTEGRATION_PRIMITIVES_SPEC.md](INTEGRATION_PRIMITIVES_SPEC.md).

The Worker selects a backend with `TRESTLE_CONNECTION_BACKEND`. An unknown or
unregistered name fails closed, and a selected but unconfigured backend
answers 503 instead of guessing.

## Support matrix

A profile is **supported** only when its evidence exists. Anything else is
**experimental** and says what is missing.

| Backend | Where credentials live | Status | Evidence |
| --- | --- | --- | --- |
| `none` (default) | nowhere: tenant Connections are disabled | Supported | Selection and fail-closed tests |
| `local` | in-memory, in the local Worker | Supported for local development and tests only | Unit tests; callback, binding, duplicate, quarantine, and reauthorization tests against PostgreSQL. Refuses to run outside `APP_ENV=local` |
| `nango` (Nango Cloud) | the developer's Nango account | Experimental (`--experimental`) | Mocked-transport tests for connect sessions, proxy headers, connection lookup and deletion, and webhook signatures. No run against a real Nango environment yet |
| `nango` (self-hosted) | the developer's Nango instance (`NANGO_HOST`) | Experimental (`--experimental`) | As above; never run against a self-hosted instance |

The backend stays experimental until it passes the proof in §23 of the
integration specification against a real Nango environment.

## Enable Nango

```sh
pnpm exec trestle integrations use nango --experimental
# or, for a self-hosted instance
pnpm exec trestle integrations use nango --host https://nango.example.com --experimental
```

This writes `integrations: { backend: nango }` to `.trestle/project.yaml`,
declares `NANGO_SECRET_KEY` (required in staging and production) and
`NANGO_WEBHOOK_SECRET`, and sets `TRESTLE_CONNECTION_BACKEND` in
`apps/worker/wrangler.jsonc`: `nango` for deployed environments and `local`
for local development, which never needs a Nango account.

Then, per deployed environment:

1. Create a Nango environment for this Trestle environment. Never share one
   Nango environment or secret key between Trestle environments;
   `trestle doctor` fails when it can see the same key in two environments.
2. `trestle secrets set NANGO_SECRET_KEY --env <env>` with that environment's
   secret key. It is the only required secret.
3. `trestle secrets set NANGO_WEBHOOK_SECRET --env <env>` with the webhook
   signing key from Nango's Environment Settings > Webhooks. This key is
   distinct from the secret key. Without it the Worker refuses Nango
   callbacks, so no Connection can complete.
4. Set Nango's webhook URL to `https://<worker>/webhooks/nango`.
5. `trestle doctor --env <env>`.

## How a Connection is made

1. A member with `organization.integrations.manage` calls
   `POST /api/tenant/integrations/connect-sessions` with a
   `providerConfigKey` (the Nango integration ID). Trestle records a durable,
   30-minute authorization attempt, then asks Nango for a connect session
   tagged only with the attempt ID. The browser receives only the short-lived
   session token.
2. Nango's hosted Connect UI performs the provider authorization and token
   exchange. Tokens stay in Nango.
3. Nango calls `POST /webhooks/nango`. The Worker verifies the
   `X-Nango-Hmac-Sha256` signature (hex HMAC-SHA256 of the raw body under
   the webhook signing key), resolves the persisted attempt by its ID,
   checks the environment, backend, and integration, confirms with Nango that
   the connection exists, and binds it to the attempt's organization once.
   Organization or end-user tags reported by Nango are never used as tenant
   authority.
4. A refresh failure reported by Nango, or a provider 401 through the proxy,
   moves the Connection to `reauthorization_required`.
5. Disconnecting (`DELETE /api/tenant/integrations/connections/:id`, with
   `organization.integrations.disconnect`) revokes local use first, then
   deletes the Nango connection. A failed deletion leaves the Connection
   revoked with cleanup pending.

Callbacks for unknown attempts or Connections, or with a mismatched binding,
are quarantined: acknowledged, logged, and never applied. A repeated callback
is answered as a duplicate and changes nothing.

The platform admin's **Integrations → Connections** view shows the selected
backend, its configuration state, whether callbacks can be verified, webhook
forwarding availability, counts by state, and Connections across tenants. It
never shows credentials, tokens, or Nango connection IDs.

## Nango deployment and licensing

Nango is source-available under the Elastic License 2.0, not an OSI
open-source license. Trestle integrates with the developer's own Nango
instance and does not redistribute Nango as a hosted service. Trestle never
provisions, resells, or operates Nango for the developer. What is available
depends on how the developer runs Nango:

| Nango deployment | Available to Trestle |
| --- | --- |
| Nango Cloud (free or paid plan) | Auth, proxy, provider webhook forwarding, syncs |
| Free self-hosted | Auth and proxy only |
| Enterprise self-hosted | Auth, proxy, provider webhook forwarding, syncs |

The Nango backend requires only auth and proxy. Provider webhook forwarding is
an optional trigger transport, and Nango syncs are out of scope. These plan
facts are Nango's and may change; the health report and admin say
"depends on the Nango plan" for self-hosted instances instead of assuming.

## Not yet built

Integration definitions and entitlement checks for which integrations a tenant
may connect, Actions and Executions, reconciliation of pending backend
cleanup, forwarded provider webhooks, and the customer Settings → Integrations
UI.
