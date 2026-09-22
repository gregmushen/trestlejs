import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertLocalDatabaseUrl, freshDevelopmentPlan } from "../src/fresh.js";

describe("fresh local development safety", () => {
  it("resolves only project-scoped local state", () => {
    expect(freshDevelopmentPlan("/work/app", "apps/worker")).toEqual({ composeFile: path.join("/work/app", "compose.yaml"), stateDirectories: [path.join("/work/app", "apps/worker", ".wrangler", "state")] });
  });
  it("rejects remote databases and escaping worker paths", () => {
    expect(() => assertLocalDatabaseUrl("postgres://user:pass@db.example.com/app")).toThrow("remote database");
    expect(() => freshDevelopmentPlan("/work/app", "../../outside")).toThrow("non-project");
  });
});
