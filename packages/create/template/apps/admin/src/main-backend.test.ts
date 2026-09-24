import { describe, expect, it } from "vitest";

import { stepUpDue } from "./api";
import { mainBackend } from "./main-backend";

const wireSession = (overrides: Record<string, unknown>) => ({
  operator: { id: "u1", email: "op@example.com" }, roles: ["platform_admin"], permissions: ["platform.overview.read"], environment: "local", capabilities: [], supportSession: null,
  assurance: null, stepUpRequiredAfter: null, ...overrides,
});
const backendFor = (wire: unknown) => mainBackend((async () => wire) as never, (reason) => ({ reason }));

describe("main backend session", () => {
  it("passes the Worker's assurance and step-up deadline through", async () => {
    const assurance = { level: "mfa", method: "totp", verifiedAt: "2026-09-23T10:00:00.000Z" };
    const session = await backendFor(wireSession({ assurance, stepUpRequiredAfter: "2026-09-23T10:15:00.000Z" })).session();
    expect(session.assurance).toEqual(assurance);
    expect(session.stepUpRequiredAfter).toBe("2026-09-23T10:15:00.000Z");
    expect(stepUpDue(session, Date.parse("2026-09-23T10:14:00.000Z"))).toBe(false);
    expect(stepUpDue(session, Date.parse("2026-09-23T10:15:00.000Z"))).toBe(true);
  });

  it("treats a session without recorded assurance as needing step-up", async () => {
    const session = await backendFor(wireSession({})).session();
    expect(session.assurance).toBeNull();
    expect(session.stepUpRequiredAfter).toBeNull();
    expect(stepUpDue(session)).toBe(true);
  });
});
