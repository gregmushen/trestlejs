import { describe, expect, it } from "vitest";
import { buildLogTailArguments } from "../src/logs.js";

describe("safe log tail arguments", () => {
  it("builds an environment-scoped Wrangler tail", () => {
    expect(buildLogTailArguments({ environment: "staging", status: "error", format: "json", samplingRate: 0.25 })).toEqual(["tail", "--env", "staging", "--format", "json", "--status", "error", "--sampling-rate", "0.25"]);
  });

  it("rejects filters that could turn logs into a sensitive-payload escape hatch", () => {
    expect(() => buildLogTailArguments({ environment: "production", search: "authorization token" })).toThrow("sensitive");
    expect(() => buildLogTailArguments({ environment: "local" })).toThrow("remote log tailing");
  });
});
