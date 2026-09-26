import { z } from "zod";

import { healthResponseSchema } from "./health.js";

/**
 * API operation contracts: the runtime Zod schemas for a route's parameters,
 * query, body, and responses, plus how the route is exposed. The OpenAPI
 * documents are generated from these and from the route policies, so there
 * are no separately maintained request/response definitions.
 *
 * Classification drives documentation exposure only; route policies still
 * enforce authentication and authority.
 */
export type ApiClassification = "public" | "browser-internal" | "admin-internal" | "webhook" | "machine";

export type ApiOperation = Readonly<{
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** Stable, unique, camelCase; generated clients use it as the function name. */
  operationId: string;
  summary: string;
  classification: ApiClassification;
  tags?: readonly string[];
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Success responses by status. Standard errors are added from the route policy. */
  responses: Readonly<Record<number, z.ZodType | null>>;
  /** The permission a generated route enforces in its handler, documented when it has no explicit route policy. */
  permission?: string;
  /** Extra declared error statuses, e.g. 409 for a revision conflict. */
  errors?: readonly number[];
}>;

export class ApiContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiContractError";
  }
}

export function defineApiOperations<const Operations extends readonly ApiOperation[]>(operations: Operations): Operations {
  const ids = new Set<string>();
  const routes = new Set<string>();
  for (const operation of operations) {
    if (!/^[a-z][A-Za-z0-9]*$/u.test(operation.operationId)) throw new ApiContractError(`Operation ${operation.operationId} must be camelCase`);
    if (ids.has(operation.operationId)) throw new ApiContractError(`Operation ${operation.operationId} is declared twice`);
    const route = `${operation.method} ${operation.path}`;
    if (routes.has(route)) throw new ApiContractError(`Route ${route} has more than one operation`);
    ids.add(operation.operationId);
    routes.add(route);
    const pathParams = [...operation.path.matchAll(/:([A-Za-z0-9_]+)/gu)].map((match) => match[1]!);
    const declared = Object.keys(operation.params?.shape ?? {});
    if (pathParams.sort().join() !== declared.sort().join()) throw new ApiContractError(`Operation ${operation.operationId} params must declare exactly ${pathParams.join(", ") || "no path parameters"}`);
  }
  return operations;
}

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  reason: z.string().optional(),
  issues: z.array(z.unknown()).optional(),
  correlationId: z.string().optional(),
}).passthrough();

/** Framework operations with declared contracts. Generated resources register below the anchor. */
export const coreApiOperations = defineApiOperations([
  { method: "GET", path: "/api/health", operationId: "getHealth", summary: "Liveness of the customer Worker", classification: "public", tags: ["system"], responses: { 200: healthResponseSchema } },
]);

/** Every operation with a declared contract. `trestle generate resource` registers resources at the anchor. */
export const apiOperations: readonly ApiOperation[] = defineApiOperations([
  ...coreApiOperations,
  // trestle:api-operations
]);

/**
 * Checks a response against the operation's declared contract. Use it in
 * contract tests; OpenAPI generation alone does not validate runtime output.
 */
export function validateApiResponse(operation: ApiOperation, status: number, body: unknown): { ok: true } | { ok: false; problem: string } {
  const success = operation.responses[status];
  if (success !== undefined) {
    if (success === null) return body === undefined || body === null || body === "" ? { ok: true } : { ok: false, problem: `${status} declares no body` };
    const parsed = success.safeParse(body);
    return parsed.success ? { ok: true } : { ok: false, problem: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
  }
  if (status >= 400) {
    const parsed = errorResponseSchema.safeParse(body);
    return parsed.success ? { ok: true } : { ok: false, problem: "error responses must have an error code" };
  }
  return { ok: false, problem: `status ${status} is not declared for ${operation.operationId}` };
}
