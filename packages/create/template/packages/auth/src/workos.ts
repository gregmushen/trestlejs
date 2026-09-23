import { createSqlRunner, type DatabaseDriver } from "@__TRESTLE_PROJECT_NAME__/db";
import { IdentityVerificationError, WorkOSClient, WorkOSError } from "@__TRESTLE_PROJECT_NAME__/integrations";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import * as z from "zod";

const STATE_COOKIE = "workos_state";

export type WorkOSPluginOptions = Readonly<{
  apiKey: string;
  clientId: string;
  databaseUrl: string;
  driver?: DatabaseDriver;
  baseUrl?: string;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}>;

type Binding = { organizationId: string; externalId: string; domain: string };

/**
 * Enterprise SSO through WorkOS as a Better Auth plugin, so sessions,
 * cookies, and assurance evidence follow the same path as every other sign-in.
 * Routing and trust come only from a Trestle binding of a WorkOS organization
 * and one of its WorkOS-verified domains (identity_connection).
 */
export function workosSso(options: WorkOSPluginOptions) {
  const client = new WorkOSClient({ apiKey: options.apiKey, clientId: options.clientId, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  const bindings = async (where: { domain?: string; externalId?: string }): Promise<Binding[]> => {
    const rows = await createSqlRunner(options.databaseUrl, options.driver).query(sql`select organization_id, external_id, domain from identity_connection
      where provider = 'workos' and kind = 'sso' and state = 'active' and domain is not null
        and (${where.domain ?? null}::text is null or domain = ${where.domain ?? null}) and (${where.externalId ?? null}::text is null or external_id = ${where.externalId ?? null})`);
    return rows.map((row) => ({ organizationId: String(row.organization_id), externalId: String(row.external_id), domain: String(row.domain) }));
  };
  const safePath = (value: string | undefined) => value && value.startsWith("/") && !value.startsWith("//") ? value : "/";

  return {
    id: "workos-sso",
    endpoints: {
      signInWorkOS: createAuthEndpoint("/workos/sign-in", {
        method: "POST",
        body: z.object({ email: z.string().email(), callbackURL: z.string().optional() }),
      }, async (ctx) => {
        const email = ctx.body.email.toLowerCase();
        const [binding] = await bindings({ domain: email.split("@")[1] ?? "" });
        if (!binding) throw new APIError("NOT_FOUND", { message: "No single sign-on connection is configured for this email domain" });
        const state = generateRandomString(32, "a-z", "A-Z", "0-9");
        await ctx.setSignedCookie(STATE_COOKIE, JSON.stringify({ state, callbackURL: safePath(ctx.body.callbackURL), externalId: binding.externalId }), ctx.context.secret, { maxAge: 600, httpOnly: true, sameSite: "lax", path: "/" });
        const url = client.authorizationUrl({ organization: binding.externalId, redirectUri: `${ctx.context.baseURL}/workos/callback`, state, loginHint: email });
        return ctx.json({ url, redirect: true });
      }),
      callbackWorkOS: createAuthEndpoint("/workos/callback", {
        method: "GET",
        query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }),
      }, async (ctx) => {
        const fail = (reason: string) => { throw ctx.redirect(`/sign-in?error=${encodeURIComponent(reason)}`); };
        const stored = await ctx.getSignedCookie(STATE_COOKIE, ctx.context.secret);
        ctx.setCookie(STATE_COOKIE, "", { maxAge: 0, path: "/" });
        if (ctx.query.error || !ctx.query.code || !ctx.query.state || !stored) return fail("sso_failed");
        const expected = JSON.parse(stored) as { state: string; callbackURL: string; externalId: string };
        if (expected.state !== ctx.query.state) return fail("sso_state_mismatch");
        let identity;
        try { identity = await client.profile(ctx.query.code); } catch (error) { return fail(error instanceof WorkOSError || error instanceof IdentityVerificationError ? "sso_provider_error" : "sso_failed"); }
        // The profile must come from the WorkOS organization this sign-in started with,
        // and its address must be in one of that organization's bound, verified domains.
        if (identity.organizationId !== expected.externalId) return fail("sso_organization_mismatch");
        const [binding] = await bindings({ externalId: expected.externalId, domain: identity.email.split("@")[1] ?? "" });
        if (!binding) return fail("sso_domain_not_verified");
        const existing = await ctx.context.internalAdapter.findUserByEmail(identity.email, { includeAccounts: true });
        const user = existing?.user ?? await ctx.context.internalAdapter.createUser({ email: identity.email, name: identity.name ?? identity.email, emailVerified: true }, { method: "sso-oidc", sso: { providerId: `workos:${identity.connectionId}` } });
        if (!existing?.accounts.some((account) => account.providerId === "workos" && account.accountId === identity.subject)) {
          await ctx.context.internalAdapter.linkAccount({ userId: user.id, providerId: "workos", accountId: identity.subject });
        }
        const member = await ctx.context.adapter.findOne<{ id: string }>({ model: "member", where: [{ field: "organizationId", value: binding.organizationId }, { field: "userId", value: user.id }] });
        if (!member) await ctx.context.adapter.create({ model: "member", data: { organizationId: binding.organizationId, userId: user.id, role: "member", createdAt: new Date() } });
        const session = await ctx.context.internalAdapter.createSession(user.id);
        await setSessionCookie(ctx, { session, user });
        throw ctx.redirect(expected.callbackURL);
      }),
    },
  } satisfies BetterAuthPlugin;
}
