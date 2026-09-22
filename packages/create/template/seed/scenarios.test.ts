import { describe, expect, it } from "vitest";
import { seedScenarios } from "./scenarios.js";

describe("deterministic seed scenarios", () => {
  it("provides stable default, demo, and two-tenant isolation fixtures", () => {
    expect(Object.keys(seedScenarios)).toEqual(["default", "demo", "tenant-isolation"]);
    expect(seedScenarios["tenant-isolation"].organizations).toHaveLength(2);
    expect(new Set(seedScenarios["tenant-isolation"].records.map((record) => record.organizationId)).size).toBe(2);
    expect(seedScenarios.demo.records[0]?.id).toBe("00000000-0000-4000-8000-000000000001");
  });
});
