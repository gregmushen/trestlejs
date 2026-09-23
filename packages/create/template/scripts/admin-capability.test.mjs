import assert from "node:assert/strict";
import { test } from "node:test";

import { adminEnabled, smokeAdmin } from "./admin-capability.mjs";

test("platform admin capability is explicitly opt-in", () => {
  assert.equal(adminEnabled("capabilities:\n  queues: false\n  admin: false\nenvironments:\n  - local\n"), false);
  assert.equal(adminEnabled("capabilities:\n  admin: true # platform admin\n"), true);
  assert.throws(() => adminEnabled("capabilities:\n  queues: false\n"), /must declare capabilities.admin/u);
});

const origins = { adminURL: "https://admin.example.test", adminApiURL: "https://admin-api.example.test" };

function fakeAdmin(overrides = {}) {
  return async (url, options = {}) => {
    const path = new URL(url).pathname;
    const key = `${options.method ?? "GET"} ${new URL(url).origin === origins.adminURL ? "spa" : "api"} ${path}`;
    const responses = {
      "GET api /api/admin/health/live": new Response("{}", { status: 200 }),
      "GET api /api/admin/session": new Response("{}", { status: 401, headers: { "access-control-allow-origin": origins.adminURL } }),
      "POST api /api/auth/sign-up/email": new Response("{}", { status: 404 }),
      "GET spa /": new Response("<html>", { status: 200, headers: { "x-robots-tag": "noindex, nofollow" } }),
      ...overrides,
    };
    return responses[key] ?? new Response("", { status: 500 });
  };
}

test("deployed platform admin smoke accepts a locked-down admin", async () => {
  await smokeAdmin(origins, fakeAdmin());
});

test("deployed platform admin smoke rejects open sign-up, anonymous sessions, and indexable pages", async () => {
  await assert.rejects(smokeAdmin(origins, fakeAdmin({ "POST api /api/auth/sign-up/email": new Response("{}", { status: 200 }) })), /exposes sign-up/u);
  await assert.rejects(smokeAdmin(origins, fakeAdmin({ "GET api /api/admin/session": new Response("{}", { status: 200, headers: { "access-control-allow-origin": origins.adminURL } }) })), /Anonymous admin session/u);
  await assert.rejects(smokeAdmin(origins, fakeAdmin({ "GET api /api/admin/session": new Response("{}", { status: 401, headers: { "access-control-allow-origin": "*" } }) })), /CORS origin/u);
  await assert.rejects(smokeAdmin(origins, fakeAdmin({ "GET spa /": new Response("<html>", { status: 200 }) })), /noindex/u);
});
