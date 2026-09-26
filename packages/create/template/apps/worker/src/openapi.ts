import { customerRoutePolicies, defaultResourcePolicy } from "@__TRESTLE_PROJECT_NAME__/authz";
import { apiOperations, buildOpenApi, type ApiRoutePolicy } from "@__TRESTLE_PROJECT_NAME__/contracts";

const key = (route: { method: string; path: string }) => `${route.method} ${route.path}`;

/** Every customer route: explicit policies, plus generated resource routes under the default resource policy. */
export function customerApiPolicies(): ApiRoutePolicy[] {
  const covered = new Set(customerRoutePolicies.map(key));
  const generated = apiOperations.filter((operation) => !covered.has(key(operation)))
    .map((operation) => ({ ...defaultResourcePolicy(operation.method, operation.path), ...(operation.permission ? { permission: operation.permission } : {}) }));
  return [...customerRoutePolicies, ...generated];
}

/** The customer API document. Outside local development only public and machine routes are published. */
export function customerOpenApi(environment: string | undefined) {
  return buildOpenApi(customerApiPolicies(), apiOperations, { title: "__TRESTLE_PROJECT_NAME__ API", version: "1.0.0", exposure: environment === "local" ? "all" : "published" });
}

/** Interactive reference for local development, rendered by Scalar from the generated document. */
export function apiReferencePage(documentUrl: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>API reference</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script id="api-reference" data-url="${documentUrl}"></script><script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1"></script></body></html>`;
}
