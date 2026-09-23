import { describe, expect, it } from "vitest";

import { computeCapabilityStatus, declaredCapabilities } from "./capabilities.js";

describe("capability status", () => {
  const declared = declaredCapabilities("capabilities:\n  queues: true\n  workflows: true\n  r2: true\n");
  const byId = (env: Record<string, unknown>) => new Map(computeCapabilityStatus(declared, "staging", env).map((status) => [status.id, status]));

  it("recognizes the Worker binding names that deployment renders", () => {
    // scripts/queue-config.mjs binds TRESTLE_EVENTS, TRESTLE_WORKFLOW, and TRESTLE_ARTIFACTS.
    const bound = byId({ TRESTLE_EVENTS: {}, TRESTLE_WORKFLOW: {}, TRESTLE_ARTIFACTS: {} });
    for (const id of ["queues", "workflows", "r2"] as const) expect(bound.get(id)).toMatchObject({ state: "deployed", healthy: true });
  });

  it("reports an unbound declared capability with its setup repair", () => {
    expect(byId({}).get("queues")).toMatchObject({ state: "declared", healthy: false, repair: "pnpm exec trestle setup --env staging" });
  });
});
