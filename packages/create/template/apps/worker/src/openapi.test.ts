import { apiOperations, validateApiResponse } from "@__TRESTLE_PROJECT_NAME__/contracts";
import { describe, expect, it } from "vitest";

import { app } from "./index.js";
import { customerApiPolicies, customerOpenApi } from "./openapi.js";

const environment = (APP_ENV: "local" | "staging") => ({ DATABASE_URL: "postgres://user:password@127.0.0.1:1/unused", DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV });

describe("customer API contracts", () => {
  it("documents every customer route and has no contract without a route", () => {
    const result = customerOpenApi("local");
    expect(result.orphaned).toEqual([]);
    const registered = new Set(app.routes.filter((route) => route.method !== "ALL").map((route) => `${route.method} ${route.path}`));
    expect(apiOperations.map((operation) => `${operation.method} ${operation.path}`).filter((route) => !registered.has(route))).toEqual([]);
    const documented = Object.values(result.document.paths as Record<string, object>).reduce((total, item) => total + Object.keys(item).length, 0);
    expect(documented + result.excluded.length).toBe(customerApiPolicies().length);
  });

  it("serves the full document and reference locally, and only published routes elsewhere", async () => {
    const local = await app.request("/api/openapi.json", {}, environment("local"));
    expect(local.status).toBe(200);
    expect(Object.keys((await local.json() as { paths: object }).paths)).toContain("/api/tenant/access");
    expect((await app.request("/api/docs", {}, environment("local"))).status).toBe(200);
    const staging = await app.request("/api/openapi.json", {}, environment("staging"));
    const paths = Object.values((await staging.json() as { paths: Record<string, Record<string, { "x-trestle-classification": string }>> }).paths).flatMap((item) => Object.values(item));
    expect(paths.every((operation) => ["public", "machine"].includes(operation["x-trestle-classification"]))).toBe(true);
    expect((await app.request("/api/docs", {}, environment("staging"))).status).toBe(404);
  });

  it("returns responses that match their declared contracts", async () => {
    const health = apiOperations.find((operation) => operation.operationId === "getHealth")!;
    const response = await app.request("/api/health", {}, environment("local"));
    expect(validateApiResponse(health, response.status, await response.json())).toEqual({ ok: true });
  });
});
