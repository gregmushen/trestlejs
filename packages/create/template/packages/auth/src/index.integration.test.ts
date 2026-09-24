import { createHmac } from "node:crypto";

import { createDatabase } from "@__TRESTLE_PROJECT_NAME__/db";
import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuth } from "./index.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const database = connectionString ? createDatabase(connectionString, "postgres-js") : undefined;
const run = `ath${Date.now()}`;
const password = "correct horse battery staple";
const origin = "http://localhost:8787";
const environment = { DATABASE_URL: connectionString ?? "", DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", BETTER_AUTH_URL: origin, APP_ENV: "local" as const };

type Assurance = { sessionId: string; level: string; method: string };

/** The postgres-js driver returns rows as an array; the Database type also admits the Neon result shape. */
async function rows<Row>(query: ReturnType<typeof sql>): Promise<Row[]> {
  return [...await database!.execute(query) as unknown as Row[]];
}

async function createUser(id: string): Promise<string> {
  const email = `${id}@example.test`;
  await database!.execute(sql`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, ${id}, ${email}, true, now(), now())`);
  await database!.execute(sql`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values (${`${id}-account`}, ${id}, 'credential', ${id}, ${await hashPassword(password)}, now(), now())`);
  return email;
}

/** Assurance rows for the user's sessions that still exist (the FK cascade removes the rest). */
async function liveAssurance(userId: string): Promise<Assurance[]> {
  return await rows<Assurance>(sql`select a.session_id as "sessionId", a.level, a.method from authentication_assurance a join session s on s.id = a.session_id where a.user_id = ${userId} order by a.verified_at`);
}

async function sessionIdFor(token: string): Promise<string> {
  const [row] = await rows<{ id: string }>(sql`select id from session where token = ${token}`);
  return row!.id;
}

async function liveSessionIds(userId: string): Promise<string[]> {
  return (await rows<{ id: string }>(sql`select id from session where user_id = ${userId} order by created_at`)).map((row) => row.id);
}

async function securityEvents(userId: string): Promise<string[]> {
  return (await rows<{ name: string }>(sql`select name from audit_event where actor_id = ${userId} and organization_id is null order by occurred_at`)).map((row) => row.name);
}

/** Sends a JSON POST to a Better Auth endpoint, carrying and collecting cookies like a browser. */
async function post(auth: ReturnType<typeof createAuth>, path: string, body: unknown, jar: Map<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  const response = await auth.handler(new Request(`${origin}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const index = pair!.indexOf("=");
    const [name, value] = [pair!.slice(0, index), pair!.slice(index + 1)];
    if (value === "" || /max-age=0/iu.test(header)) jar.delete(name); else jar.set(name, value);
  }
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30s) for the secret in an otpauth:// URI. */
function totp(uri: string, now = Date.now()): string {
  const encoded = new URL(uri).searchParams.get("secret")!.replace(/=+$/u, "");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of encoded.toUpperCase()) bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/gu)!.map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

suite("auth hooks against PostgreSQL", () => {
  const plain = `${run}-plain`;
  const operator = `${run}-operator`;
  const rotated = `${run}-rotated`;
  const users = [plain, operator, rotated];
  let operatorEmail = "";
  let totpUri = "";

  beforeAll(async () => {
    await createUser(plain);
    operatorEmail = await createUser(operator);
    await createUser(rotated);
  });

  afterAll(async () => {
    for (const id of users) {
      await database!.execute(sql`delete from audit_event where actor_id = ${id} and organization_id is null`);
      await database!.execute(sql`delete from "user" where id = ${id}`);
    }
  });

  it("records password assurance for a password sign-in without a second factor", async () => {
    const jar = new Map<string, string>();
    const signIn = await post(createAuth(environment), "/sign-in/email", { email: `${plain}@example.test`, password }, jar);
    expect(signIn.status).toBe(200);
    expect(await liveAssurance(plain)).toEqual([{ sessionId: await sessionIdFor(String(signIn.body.token)), level: "password", method: "password" }]);
  });

  it("leaves a rotated session without assurance when its prior session had none", async () => {
    const auth = createAuth(environment);
    const jar = new Map<string, string>();
    await post(auth, "/sign-in/email", { email: `${rotated}@example.test`, password }, jar);
    await database!.execute(sql`delete from authentication_assurance where user_id = ${rotated}`);
    // Changing the password with revokeOtherSessions replaces the session from inside the old one.
    const changed = await post(auth, "/change-password", { currentPassword: password, newPassword: `${password}!`, revokeOtherSessions: true }, jar);
    expect(changed.status).toBe(200);
    expect(await liveSessionIds(rotated)).toEqual([await sessionIdFor(String(changed.body.token))]);
    expect(await liveAssurance(rotated)).toEqual([]);
  });

  it("keeps an enrollment session at its prior assurance, then records MFA only for a second-factor sign-in", async () => {
    const auth = createAuth(environment, { factors: true });
    const jar = new Map<string, string>();
    const signIn = await post(auth, "/sign-in/email", { email: operatorEmail, password }, jar);
    expect(signIn.status).toBe(200);

    // Enrollment needs only the password; verifying the first code rotates the session.
    const enable = await post(auth, "/two-factor/enable", { password }, jar);
    expect(enable.status).toBe(200);
    totpUri = String(enable.body.totpURI);
    const [signedIn] = await rows<{ verifiedAt: Date }>(sql`select verified_at as "verifiedAt" from authentication_assurance where user_id = ${operator}`);
    const verify = await post(auth, "/two-factor/verify-totp", { code: totp(totpUri) }, jar);
    expect(verify.status).toBe(200);
    // The response still carries the old token (better-auth verify-two-factor.mjs); the rotated session is the only live one.
    const [enrolled, ...others] = await liveSessionIds(operator);
    expect(others).toEqual([]);
    // Not MFA: a password-only holder could otherwise mint an MFA session by enrolling their own authenticator.
    expect(await liveAssurance(operator)).toEqual([{ sessionId: enrolled!, level: "password", method: "password" }]);
    // The carried evidence keeps its original time, so rotating a session never refreshes it.
    const [carried] = await rows<{ verifiedAt: Date }>(sql`select verified_at as "verifiedAt" from authentication_assurance where session_id = ${enrolled!}`);
    expect(carried!.verifiedAt).toEqual(signedIn!.verifiedAt);
    expect(await securityEvents(operator)).toEqual(["security.two_factor.enrollment_started", "security.two_factor.enabled"]);

    // A fresh sign-in stops at the second-factor challenge; its interim session is deleted with its assurance.
    const challengeJar = new Map<string, string>();
    const challenged = await post(auth, "/sign-in/email", { email: operatorEmail, password }, challengeJar);
    expect(challenged.status).toBe(200);
    expect(challenged.body.twoFactorRedirect).toBe(true);
    expect(await liveAssurance(operator)).toEqual([{ sessionId: enrolled!, level: "password", method: "password" }]);

    // The challenge is answered with the two-factor cookie, not a session: the new session proves MFA.
    const secondFactor = await post(auth, "/two-factor/verify-totp", { code: totp(totpUri) }, challengeJar);
    expect(secondFactor.status).toBe(200);
    const mfaSession = await sessionIdFor(String(secondFactor.body.token));
    expect(await liveAssurance(operator)).toEqual([
      { sessionId: enrolled!, level: "password", method: "password" },
      { sessionId: mfaSession, level: "mfa", method: "totp" },
    ]);
  });

  it("upgrades a signed-in operator who steps up with an enrolled second factor", async () => {
    const auth = createAuth(environment, { factors: true });
    await database!.execute(sql`delete from session where user_id = ${operator}`);
    const jar = new Map<string, string>();
    await post(auth, "/sign-in/email", { email: operatorEmail, password }, jar);
    const signedIn = await post(auth, "/two-factor/verify-totp", { code: totp(totpUri) }, jar);
    const current = await sessionIdFor(String(signedIn.body.token));
    await database!.execute(sql`update authentication_assurance set level = 'password', method = 'password', verified_at = now() - interval '20 minutes' where session_id = ${current}`);

    // Step-up re-authenticates while the session cookie is still sent; the challenge response expires it.
    const challenged = await post(auth, "/sign-in/email", { email: operatorEmail, password }, jar);
    expect(challenged.body.twoFactorRedirect).toBe(true);
    const stepUp = await post(auth, "/two-factor/verify-totp", { code: totp(totpUri) }, jar);
    expect(stepUp.status).toBe(200);
    const stepped = await sessionIdFor(String(stepUp.body.token));
    expect(stepped).not.toBe(current);
    expect(await liveAssurance(operator)).toEqual([
      { sessionId: current, level: "password", method: "password" },
      { sessionId: stepped, level: "mfa", method: "totp" },
    ]);

    // Verifying a code on an existing session (no challenge) creates no session and proves nothing new.
    const [before] = await rows<{ verifiedAt: Date }>(sql`select verified_at as "verifiedAt" from authentication_assurance where session_id = ${stepped}`);
    const again = await post(auth, "/two-factor/verify-totp", { code: totp(totpUri) }, jar);
    expect(again.body.token).toBe(stepUp.body.token);
    expect(await liveSessionIds(operator)).toEqual([current, stepped]);
    const [after] = await rows<{ verifiedAt: Date }>(sql`select verified_at as "verifiedAt" from authentication_assurance where session_id = ${stepped}`);
    expect(after!.verifiedAt).toEqual(before!.verifiedAt);
  });
});
