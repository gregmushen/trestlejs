import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { ProjectManifest } from "@trestlejs/core";

export type ResourceDeclaration = {
  schemaVersion: number;
  name: string;
  tenant: boolean;
  crud: boolean;
  persistence?: { table: string; schema: string };
  contracts?: string;
  files?: string[];
  registrations?: string[];
  routes?: Array<{ method: string; path: string; auth: boolean }>;
};

export type RouteDeclaration = {
  method: string;
  path: string;
  auth: boolean;
  resource?: string;
  source?: string;
};

export async function inspectResources(root: string): Promise<ResourceDeclaration[]> {
  const directory = path.join(root, ".trestle", "resources");
  let files: string[];
  try { files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort(); }
  catch { return []; }
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(directory, file), "utf8")) as ResourceDeclaration));
}

export async function inspectRoutes(root: string, manifest: ProjectManifest): Promise<RouteDeclaration[]> {
  const routes: RouteDeclaration[] = (await inspectResources(root)).flatMap((resource) => (resource.routes ?? []).map((route) => ({ ...route, resource: resource.name, ...(resource.persistence?.schema ? { source: resource.persistence.schema } : {}) })));
  const workerPath = manifest.apps.worker;
  if (workerPath) {
    const sourcePath = path.join(root, workerPath, "src", "index.ts");
    try {
      const source = await readFile(sourcePath, "utf8");
      for (const match of source.matchAll(/app\.(get|post|patch|put|delete)\("([^"\n]+)"/gu)) {
        const method = match[1]?.toUpperCase() ?? "GET";
        const routePath = match[2] ?? "/";
        const publicRoute = routePath === "/api/health" || routePath.startsWith("/api/dev/") || routePath.includes("/webhooks/");
        if (!routes.some((route) => route.method === method && route.path === routePath)) routes.push({ method, path: routePath, auth: !publicRoute, source: path.relative(root, sourcePath) });
      }
    } catch { /* Doctor reports missing Worker source separately. */ }
  }
  return routes.sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`));
}
