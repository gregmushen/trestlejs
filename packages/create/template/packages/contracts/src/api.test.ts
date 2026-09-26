import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ApiContractError, apiOperations, defineApiOperations, validateApiResponse } from "./api.js";
import { buildOpenApi } from "./openapi.js";

const item = z.object({ id: z.string().uuid(), name: z.string() });
const operations = defineApiOperations([
  { method: "GET", path: "/api/items/:id", operationId: "getItem", summary: "Read an item", classification: "browser-internal", params: z.object({ id: z.string().uuid() }), responses: { 200: z.object({ item }) }, errors: [404] },
  { method: "POST", path: "/api/items", operationId: "createItem", summary: "Create an item", classification: "machine", body: z.object({ name: z.string().min(1) }), responses: { 201: z.object({ item }) } },
]);
const policies = [
  { method: "GET", path: "/api/items/:id", audience: "tenant", permission: "resource.read" },
  { method: "POST", path: "/api/items", audience: "tenant", permission: "resource.write", principals: ["user", "api_key"] },
  { method: "GET", path: "/api/untyped", audience: "session" },
  { method: "POST", path: "/api/auth/*", public: true, audience: "public" },
] as const;

describe("API contracts", () => {
  it("rejects duplicate, misnamed, and mismatched operations", () => {
    expect(() => defineApiOperations([operations[0], { ...operations[0], path: "/api/other/:id" }])).toThrow(ApiContractError);
    expect(() => defineApiOperations([{ ...operations[0], operationId: "Get-Item" }])).toThrow("camelCase");
    expect(() => defineApiOperations([{ ...operations[0], params: z.object({}) }])).toThrow("params must declare exactly id");
    expect(apiOperations.map((operation) => operation.operationId)).toContain("getHealth");
  });

  it("documents every route with its authority and reports what it cannot type", () => {
    const result = buildOpenApi(policies, operations, { title: "Test", version: "1", exposure: "all" });
    const paths = result.document.paths as Record<string, Record<string, any>>;
    expect(paths["/api/items/{id}"]!.get).toMatchObject({ operationId: "getItem", "x-trestle-permission": "resource.read", security: [{ session: [] }] });
    expect(Object.keys(paths["/api/items/{id}"]!.get.responses)).toEqual(["200", "400", "401", "403", "404"]);
    expect(paths["/api/items"]!.post).toMatchObject({ "x-trestle-classification": "machine", security: [{ session: [] }, { apiKey: [] }] });
    expect(paths["/api/items"]!.post.requestBody.content["application/json"].schema).toMatchObject({ type: "object", required: ["name"] });
    expect(result.undocumented).toEqual([expect.objectContaining({ path: "/api/untyped" })]);
    expect(result.excluded).toEqual([expect.objectContaining({ path: "/api/auth/*" })]);
    expect(buildOpenApi(policies.slice(1), operations, { title: "Test", version: "1", exposure: "all" }).orphaned).toEqual([expect.objectContaining({ path: "/api/items/:id" })]);
  });

  it("publishes only public and machine routes outside local development", () => {
    const published = buildOpenApi(policies, operations, { title: "Test", version: "1", exposure: "published" });
    expect(Object.keys(published.document.paths as object)).toEqual(["/api/items"]);
  });

  it("validates runtime responses against the declared contract", () => {
    const [get] = operations;
    expect(validateApiResponse(get, 200, { item: { id: "00000000-0000-4000-8000-000000000001", name: "A" } })).toEqual({ ok: true });
    expect(validateApiResponse(get, 200, { item: { id: "nope" } })).toMatchObject({ ok: false });
    expect(validateApiResponse(get, 404, { error: "not_found" })).toEqual({ ok: true });
    expect(validateApiResponse(get, 201, {})).toMatchObject({ ok: false, problem: expect.stringContaining("not declared") });
  });
});
