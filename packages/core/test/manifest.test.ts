import { describe, expect, it } from "vitest";

import { ManifestError, parseProjectManifest } from "../src/index.js";

const validManifest = `
schemaVersion: 1
project:
  name: hello
apps:
  site: apps/site
  app: apps/app
  worker: apps/worker
packages:
  contracts: packages/contracts
tenancy:
  model: organization
  enforcement: postgres-rls
database:
  engine: postgresql
  defaultProvider: neon
site:
  framework: astro
  rendering: static
  starter: southwind
capabilities:
  r2: true
  queues: true
  workflows: true
  durableObjects: true
  admin: false
environments:
  - local
  - staging
  - production
`;

describe("project manifest", () => {
  it("parses a valid version-one manifest", () => {
    const manifest = parseProjectManifest(validManifest);
    expect(manifest.project.name).toBe("hello");
    expect(manifest.tenancy.enforcement).toBe("postgres-rls");
  });

  it("rejects unknown schema versions", () => {
    expect(() => parseProjectManifest(validManifest.replace("schemaVersion: 1", "schemaVersion: 2"))).toThrow(
      ManifestError,
    );
  });

  it("rejects paths that escape the project", () => {
    expect(() => parseProjectManifest(validManifest.replace("apps/app", "../app"))).toThrow(
      ManifestError,
    );
  });

  it("requires the local environment", () => {
    expect(() => parseProjectManifest(validManifest.replace("  - local\n", ""))).toThrow(
      ManifestError,
    );
  });
});
