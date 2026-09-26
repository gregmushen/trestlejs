import { describe, expect, it } from "vitest";

import { admin, adminDependencies, type AdminEnvironment } from "./index.js";

const environment: AdminEnvironment = { DATABASE_URL: "postgres://user:password@127.0.0.1:1/unused", DATABASE_DRIVER: "postgres-js", BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" };

describe("admin API document", () => {
  it("is served only to platform operators", async () => {
    adminDependencies.session = async () => null;
    expect((await admin.request("/api/admin/openapi.json", {}, environment)).status).toBe(401);
    adminDependencies.session = async () => ({ user: { id: "operator-1", email: "operator-1@example.test" }, session: { id: "session-1" } });
    adminDependencies.platformRoles = async () => [];
    expect((await admin.request("/api/admin/openapi.json", {}, environment)).status).toBe(403);
    adminDependencies.platformRoles = async () => ["platform_operator"];
    adminDependencies.assurance = async () => ({ sessionId: "session-1", userId: "operator-1", level: "password", method: "password", verifiedAt: new Date() });
    adminDependencies.enrolledFactor = async () => null;
    const response = await admin.request("/api/admin/openapi.json", {}, environment);
    expect(response.status).toBe(200);
    const document = await response.json() as { paths: Record<string, Record<string, { "x-trestle-permission"?: string }>> };
    expect(document.paths["/api/admin/overview"]?.get?.["x-trestle-permission"]).toBe("platform.overview.read");
  });
});
