import { describe, expect, it } from "vitest";

import { IdentityVerificationError } from "./types.js";
import { signWorkOSWebhook, WorkOSClient, WorkOSDirectoryEvents, WorkOSError } from "./workos.js";

type Call = { url: string; init: RequestInit };
function stub(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const route = routes[`${init.method ?? "GET"} ${path}`];
    return route ? route({ url, init }) : new Response("not found", { status: 404 });
  };
  return { calls, fetcher };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("WorkOS HTTP adapter", () => {
  it("builds the SSO authorization URL for the bound WorkOS organization", () => {
    const url = new URL(new WorkOSClient({ apiKey: "sk_test", clientId: "client_1" }).authorizationUrl({ organization: "org_01", redirectUri: "https://app.example/api/auth/workos/callback", state: "state-1", loginHint: "ada@acme.test" }));
    expect(url.origin + url.pathname).toBe("https://api.workos.com/sso/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "client_1", redirect_uri: "https://app.example/api/auth/workos/callback", response_type: "code", state: "state-1", organization: "org_01", login_hint: "ada@acme.test" });
  });

  it("exchanges a code for a normalized profile with the API key as client secret", async () => {
    const { calls, fetcher } = stub({ "POST /sso/token": () => json({ access_token: "at", profile: { id: "prof_1", connection_id: "conn_1", organization_id: "org_01", email: "Ada@Acme.test", first_name: "Ada", last_name: "Lovelace", raw_attributes: {} } }) });
    const identity = await new WorkOSClient({ apiKey: "sk_test", clientId: "client_1", fetcher }).profile("code-1");
    expect(identity).toEqual({ provider: "workos", connectionId: "conn_1", subject: "prof_1", email: "ada@acme.test", emailVerified: false, name: "Ada Lovelace", organizationId: "org_01" });
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({ client_id: "client_1", client_secret: "sk_test", grant_type: "authorization_code", code: "code-1" });
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("reads organizations, directories, users, and groups, and reports failures without response bodies", async () => {
    const { fetcher } = stub({
      "GET /organizations/org_01": () => json({ id: "org_01", name: "Acme", domains: [{ domain: "ACME.test", state: "verified" }, { domain: "acme.dev", state: "pending" }] }),
      "GET /directories/directory_1": () => json({ id: "directory_1", organization_id: "org_01", state: "linked", type: "okta scim v2.0", name: "Okta" }),
      "GET /directory_users/user_1": () => json({ id: "user_1", directory_id: "directory_1", organization_id: "org_01", emails: [{ primary: true, value: "Ada@Acme.test" }], first_name: "Ada", state: "active" }),
      "GET /directory_groups": () => json({ data: [{ id: "group_eng", name: "Engineering" }] }),
      "GET /organizations/org_missing": () => json({ message: "secret detail" }, 404),
    });
    const client = new WorkOSClient({ apiKey: "sk_test", clientId: "client_1", fetcher });
    expect((await client.organization("org_01")).domains).toEqual([{ domain: "acme.test", state: "verified" }, { domain: "acme.dev", state: "pending" }]);
    expect(await client.directory("directory_1")).toMatchObject({ organizationId: "org_01", state: "linked" });
    expect(await client.directoryUser("user_1")).toMatchObject({ email: "ada@acme.test", name: "Ada", state: "active" });
    expect(await client.directoryUserGroups("user_1")).toEqual([{ externalGroupId: "group_eng", name: "Engineering" }]);
    const failure = await client.organization("org_missing").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkOSError);
    expect(String((failure as Error).message)).not.toContain("secret detail");
  });
});

describe("WorkOS directory events", () => {
  const secret = "wh_secret_0123456789";
  const now = new Date("2026-09-22T12:00:00Z");
  const body = JSON.stringify({ id: "event_01", event: "dsync.user.updated", created_at: "2026-09-22T11:59:59Z", data: { id: "user_1", directory_id: "directory_1", organization_id: "org_01", emails: [{ primary: true, value: "ada@acme.test" }], first_name: "Ada", state: "inactive" } });

  it("verifies the signature and normalizes lifecycle events", async () => {
    const events = await new WorkOSDirectoryEvents(secret).verify({ body, headers: { "workos-signature": await signWorkOSWebhook(secret, body, now.getTime() - 1_000) } }, now);
    expect(events).toEqual([{ id: "workos:event_01", type: "user.deactivated", directoryId: "directory_1", organizationId: null, occurredAt: new Date("2026-09-22T11:59:59Z"),
      user: { provider: "workos", directoryId: "directory_1", externalId: "user_1", email: "ada@acme.test", name: "Ada", active: false, groups: [] } }]);
  });

  it("rejects forged, tampered, stale, and unsigned events", async () => {
    const source = new WorkOSDirectoryEvents(secret);
    const verify = async (headers: Record<string, string>, payload = body) => await source.verify({ body: payload, headers }, now).catch((error: unknown) => error);
    expect(await verify({})).toBeInstanceOf(IdentityVerificationError);
    expect(await verify({ "workos-signature": await signWorkOSWebhook("other-secret", body, now.getTime()) })).toBeInstanceOf(IdentityVerificationError);
    expect(await verify({ "workos-signature": await signWorkOSWebhook(secret, body, now.getTime()) }, body.replace("inactive", "active"))).toBeInstanceOf(IdentityVerificationError);
    expect(await verify({ "workos-signature": await signWorkOSWebhook(secret, body, now.getTime() - 600_000) })).toBeInstanceOf(IdentityVerificationError);
  });

  it("acknowledges unrelated events without acting on them", async () => {
    const other = JSON.stringify({ id: "event_02", event: "connection.activated", data: {} });
    expect(await new WorkOSDirectoryEvents(secret).verify({ body: other, headers: { "workos-signature": await signWorkOSWebhook(secret, other, now.getTime()) } }, now)).toEqual([]);
  });
});
