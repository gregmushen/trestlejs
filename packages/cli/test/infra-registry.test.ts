import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { registryManifest, renderRegistryManifest, validateRegistryManifest } from "../src/infra/registry.js";

const ref = "a".repeat(40);
const valid = registryManifest({ repo: "https://github.com/gregmushen/trestle-starter", ref, trestleVersion: "0.1.0-beta.3", services: ["neon/postgres"] });

describe("registry manifest (D-06)", () => {
  it("renders a pinned, catalog-validated manifest with lifecycle scripts disabled", () => {
    expect(validateRegistryManifest(valid)).toEqual([]);
    const rendered = parse(renderRegistryManifest(valid)) as Record<string, unknown>;
    expect(rendered).toMatchObject({ ref, services: ["neon/postgres"], install_command: expect.stringContaining("--ignore-scripts"), guided: { framework: "astro" } });
  });

  it("rejects unpinned refs, invented services, TanStack Start classification, provisioning installs and secrets", () => {
    const cases: Array<[Partial<typeof valid>, RegExp]> = [
      [{ ref: "main" }, /pin a full 40-character commit SHA/u],
      [{ services: ["neon/serverless"] }, /not a service identifier in the recorded catalog/u],
      [{ services: [] }, /at least one Projects service/u],
      [{ guided: { category: "saas", framework: "tanstack-start" } }, /not TanStack Start/u],
      [{ install_command: "pnpm install" }, /lifecycle scripts/u],
      [{ install_command: "pnpm install --ignore-scripts && stripe projects add neon/postgres" }, /must not provision/u],
      [{ repo: "https://gitlab.com/x/y" }, /public GitHub/u],
      [{ next_steps: [{ label: "x", command: "export STRIPE_API_KEY=sk_live_ABCDEFGH12345678" }] }, /credential-like/u],
    ];
    for (const [change, reason] of cases) expect(validateRegistryManifest({ ...valid, ...change }).join(" "), String(reason)).toMatch(reason);
    expect(() => renderRegistryManifest({ ...valid, ref: "" })).toThrow(/invalid/u);
  });
});
