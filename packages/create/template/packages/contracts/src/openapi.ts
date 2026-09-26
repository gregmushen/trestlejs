import { z } from "zod";

import { errorResponseSchema, type ApiClassification, type ApiOperation } from "./api.js";

/** The route-policy fields the document needs (structurally compatible with @project/authz RoutePolicy). */
export type ApiRoutePolicy = Readonly<{
  method: string;
  path: string;
  public?: true;
  permission?: string;
  entitlement?: string;
  principals?: readonly string[];
  audience: "tenant" | "platform" | "public" | "session" | "support";
}>;

export type OpenApiReportEntry = Readonly<{ method: string; path: string; reason: string }>;

export type OpenApiResult = Readonly<{
  document: Record<string, unknown>;
  /** Routes documented from their policy only: authority is known, schemas are not. */
  undocumented: readonly OpenApiReportEntry[];
  /** Routes left out of this document, and why. */
  excluded: readonly OpenApiReportEntry[];
  /** Contracts that name a route with no policy (contract drift). */
  orphaned: readonly OpenApiReportEntry[];
}>;

export type OpenApiOptions = Readonly<{
  title: string;
  version: string;
  /** "all" documents every route (local development and operators); "published" only public and machine routes. */
  exposure: "all" | "published";
  serverUrl?: string;
}>;

const classify = (policy: ApiRoutePolicy): ApiClassification =>
  policy.audience === "platform" ? "admin-internal"
    : policy.public && /\/webhooks?\//u.test(policy.path) ? "webhook"
      : policy.public ? "public"
        : policy.principals?.includes("api_key") ? "machine" : "browser-internal";

const openApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/gu, "{$1}");
const schema = (value: z.ZodType) => z.toJSONSchema(value, { io: "input", unrepresentable: "any" });
const outputSchema = (value: z.ZodType) => z.toJSONSchema(value, { io: "output", unrepresentable: "any" });

function operationId(method: string, path: string): string {
  const words = path.replace(/^\/api\//u, "").split(/[/:_-]+/u).filter(Boolean);
  return [method.toLowerCase(), ...words.map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`)].join("");
}

/**
 * Builds an OpenAPI 3.1 document from route policies and operation contracts.
 * Every policy appears (except excluded third-party handlers); routes without a
 * contract are documented with their authority and reported as undocumented.
 */
export function buildOpenApi(policies: readonly ApiRoutePolicy[], operations: readonly ApiOperation[], options: OpenApiOptions): OpenApiResult {
  const paths: Record<string, Record<string, unknown>> = {};
  const undocumented: OpenApiReportEntry[] = [];
  const excluded: OpenApiReportEntry[] = [];
  const byRoute = new Map(operations.map((operation) => [`${operation.method} ${operation.path}`, operation]));
  const usedIds = new Set(operations.map((operation) => operation.operationId));
  for (const policy of policies) {
    const route = `${policy.method} ${policy.path}`;
    if (policy.path.includes("*")) {
      excluded.push({ method: policy.method, path: policy.path, reason: "wildcard handler (Better Auth); see the Better Auth API reference" });
      continue;
    }
    const contract = byRoute.get(route);
    const classification = contract?.classification ?? classify(policy);
    if (options.exposure === "published" && classification !== "public" && classification !== "machine") {
      excluded.push({ method: policy.method, path: policy.path, reason: `${classification} routes are not published` });
      continue;
    }
    if (!contract) undocumented.push({ method: policy.method, path: policy.path, reason: "no operation contract declared; request and response schemas are unknown" });
    let id = contract?.operationId ?? operationId(policy.method, policy.path);
    while (!contract && usedIds.has(id)) id = `${id}Route`;
    usedIds.add(id);
    const parameters: unknown[] = [];
    for (const name of [...policy.path.matchAll(/:([A-Za-z0-9_]+)/gu)].map((match) => match[1]!)) {
      const declared = contract?.params?.shape[name] as z.ZodType | undefined;
      parameters.push({ name, in: "path", required: true, schema: declared ? schema(declared) : { type: "string" } });
    }
    for (const [name, value] of Object.entries(contract?.query?.shape ?? {})) {
      parameters.push({ name, in: "query", required: !(value as z.ZodType).safeParse(undefined).success, schema: schema(value as z.ZodType) });
    }
    if (policy.audience === "tenant") parameters.push({ name: "x-trestle-tenant", in: "header", required: true, schema: { type: "string" }, description: "Active organization ID" });
    const responses: Record<string, unknown> = {};
    for (const [status, body] of Object.entries(contract?.responses ?? { 200: undefined })) {
      responses[status] = body ? { description: "Success", content: { "application/json": { schema: outputSchema(body) } } } : { description: body === null ? "No content" : "Success (schema not declared)" };
    }
    const error = { content: { "application/json": { schema: outputSchema(errorResponseSchema) } } };
    const errors = new Set<number>([...(contract?.errors ?? []), ...(contract?.body || contract?.query || contract?.params ? [400] : []), ...(policy.public ? [] : [401, 403])]);
    for (const status of [...errors].sort()) responses[String(status)] = { description: ({ 400: "Validation failed", 401: "Not signed in", 403: "Permission, entitlement, or tenant denied", 404: "Not found", 409: "Conflict" } as Record<number, string>)[status] ?? "Error", ...error };
    const method = policy.method.toLowerCase();
    (paths[openApiPath(policy.path)] ??= {})[method] = {
      operationId: id,
      summary: contract?.summary ?? route,
      tags: contract?.tags ?? [policy.path.split("/")[2] ?? "api"],
      ...(parameters.length ? { parameters } : {}),
      ...(contract?.body ? { requestBody: { required: true, content: { "application/json": { schema: schema(contract.body) } } } } : {}),
      responses,
      ...(policy.public ? { security: [] } : { security: policy.principals?.includes("api_key") ? [{ session: [] }, { apiKey: [] }] : [{ session: [] }] }),
      "x-trestle-classification": classification,
      "x-trestle-audience": policy.audience,
      ...(policy.permission ? { "x-trestle-permission": policy.permission } : {}),
      ...(policy.entitlement ? { "x-trestle-entitlement": policy.entitlement } : {}),
    };
  }
  const declaredRoutes = new Set(policies.map((policy) => `${policy.method} ${policy.path}`));
  const orphaned = operations.filter((operation) => !declaredRoutes.has(`${operation.method} ${operation.path}`))
    .map((operation) => ({ method: operation.method, path: operation.path, reason: `operation ${operation.operationId} has no route policy` }));
  return {
    document: {
      openapi: "3.1.0",
      info: { title: options.title, version: options.version },
      ...(options.serverUrl ? { servers: [{ url: options.serverUrl }] } : {}),
      paths,
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "better-auth.session_token", description: "Signed-in browser session" },
          apiKey: { type: "http", scheme: "bearer", description: "Service-account API key" },
        },
      },
    },
    undocumented, excluded, orphaned,
  };
}
