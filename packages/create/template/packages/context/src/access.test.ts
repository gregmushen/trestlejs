import { describe, expect, it } from "vitest";
import { AccessDeniedError, createAccessController, type Entitlements } from "./index.js";

function entitlements(enabled: readonly string[]): Entitlements {
  const values = new Set(enabled);
  return {
    has: (code) => values.has(code),
    resolve: (code) => ({ code, enabled: values.has(code), source: "plan", effectiveAt: new Date("2026-01-01T00:00:00.000Z") }),
  };
}

describe("access control", () => {
  it("requires actor permission and commercial entitlement independently", () => {
    const access = createAccessController({ planes: { application: new Set(["publication:write"]) } }, entitlements(["publication.advanced"]));
    expect(access.check({ plane: "application", permission: "publication:write", entitlement: "publication.advanced" })).toMatchObject({ allowed: true, missing: [] });
  });

  it("does not manufacture an entitlement from a permission", () => {
    const access = createAccessController({ planes: { application: new Set(["publication:write"]) } }, entitlements([]));
    expect(access.check({ plane: "application", permission: "publication:write", entitlement: "publication.advanced" })).toMatchObject({ allowed: false, missing: ["entitlement"] });
  });

  it("rejects authority from the wrong plane", () => {
    const access = createAccessController({ planes: { organization: new Set(["billing:manage"]) } }, entitlements([]));
    expect(() => access.require({ plane: "platform", permission: "billing:manage" })).toThrow(AccessDeniedError);
    expect(access.check({ plane: "platform", permission: "billing:manage" }).missing).toContain("authority_plane");
  });

  it("does not transfer a permission with the same code between assigned planes", () => {
    const access = createAccessController({ planes: { organization: new Set(["resource:write"]), application: new Set(["resource:read"]) } }, entitlements([]));
    expect(access.check({ plane: "application", permission: "resource:write" })).toMatchObject({ allowed: false, missing: ["permission"] });
    expect(access.check({ plane: "application", permission: "resource:read" })).toMatchObject({ allowed: true, missing: [] });
  });
});
