import { describe, expect, it } from "vitest";
import { workflowArguments } from "../src/workflows.js";

describe("Workflow operations", () => {
  it("targets local development explicitly", () => {
    expect(workflowArguments("list", "publish", undefined, "local", true)).toEqual(["workflows", "instances", "list", "publish", "--local", "--json"]);
  });
  it("targets one remote instance without translating restart semantics", () => {
    expect(workflowArguments("retry", "publish", "instance-1", "staging")).toEqual(["workflows", "instances", "restart", "publish", "instance-1", "--env", "staging"]);
  });
  it("rejects shell-shaped provider identifiers", () => {
    expect(() => workflowArguments("status", "publish;destroy", "latest", "production")).toThrow("invalid");
  });
});
