import { describe, expect, it } from "vitest";

import { ExecutionContextError, resolveExecutionContext } from "./execution-context.js";

const environment = {
  DATABASE_URL: "postgres://user:password@localhost/database",
  DATABASE_DRIVER: "postgres-js" as const,
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters",
};

const session = { user: { id: "user-1", email: "user@example.test" }, session: { activeOrganizationId: "org-a" } };

type Dependencies = NonNullable<Parameters<typeof resolveExecutionContext>[2]>;
const dependencies = (overrides: Partial<Dependencies> = {}): Dependencies => ({
  getSession: async () => session,
  findMembership: async () => ({ role: "owner" }),
  loadApplicationRoles: async () => ["editor"],
  findSubscription: async () => null,
  ...overrides,
});

describe("execution context", () => {
  it("revalidates membership and resolves each plane from its own assignments", async () => {
    const seen: string[] = [];
    const context = await resolveExecutionContext(new Headers({ "x-correlation-id": "corr-1" }), environment, dependencies({
      findMembership: async (userId, organizationId) => { seen.push(userId, organizationId); return { role: "owner" }; },
      loadApplicationRoles: async (userId, organizationId) => { seen.push(`roles:${userId}:${organizationId}`); return ["editor"]; },
    }));
    expect(seen).toEqual(["user-1", "org-a", "roles:user-1:org-a"]);
    expect(context.tenant).toEqual({ organizationId: "org-a", role: "owner" });
    expect(context.assignments).toEqual({ organization: ["owner"], application: ["editor"] });
    expect(context.access.check({ permission: "organization.webhooks.manage" })).toBe(true);
    expect(context.access.check({ permission: "resource.write" })).toBe(true);
    expect(context.access.check({ permission: "application.roles.assign" })).toBe(false);
    expect(context.access.explain({ permission: "resource.write" }).permission).toMatchObject({ plane: "application", grantedBy: ["editor"] });
    expect(context.correlation.correlationId).toBe("corr-1");
  });

  it("does not let an organization Owner without application roles act in the application plane", async () => {
    const context = await resolveExecutionContext(new Headers(), environment, dependencies({ loadApplicationRoles: async () => [] }));
    expect(context.access.check({ permission: "organization.billing.manage" })).toBe(true);
    expect(context.access.explain({ permission: "resource.read" })).toMatchObject({ allowed: false, reason: "permission_missing" });
  });

  it("does not let application roles grant organization authority", async () => {
    const context = await resolveExecutionContext(new Headers(), environment, dependencies({ findMembership: async () => ({ role: "member" }), loadApplicationRoles: async () => ["app_admin"] }));
    expect(context.access.check({ permission: "application.roles.assign" })).toBe(true);
    expect(context.access.check({ permission: "organization.webhooks.manage" })).toBe(false);
    expect(context.access.check({ permission: "organization.billing.manage" })).toBe(false);
  });

  it("grants a reader only application reads regardless of organization role", async () => {
    const context = await resolveExecutionContext(new Headers(), environment, dependencies({ findMembership: async () => ({ role: "member" }), loadApplicationRoles: async () => ["reader"] }));
    expect(context.access.check({ permission: "resource.read" })).toBe(true);
    expect(context.access.explain({ permission: "resource.write" }).reason).toBe("permission_missing");
    expect([...context.permissions]).toEqual(expect.arrayContaining(["organization.read", "resource.read"]));
  });

  it("ignores unknown role keys rather than granting anything", async () => {
    const context = await resolveExecutionContext(new Headers(), environment, dependencies({ findMembership: async () => ({ role: "superuser" }), loadApplicationRoles: async () => ["root"] }));
    expect(context.permissions.size).toBe(0);
  });

  it("fails closed for revoked membership", async () => {
    await expect(resolveExecutionContext(new Headers(), environment, dependencies({ findMembership: async () => null })))
      .rejects.toMatchObject<Partial<ExecutionContextError>>({ code: "not_found", status: 404 });
  });

  it("does not accept a selected tenant without current membership", async () => {
    const selected: string[] = [];
    await expect(resolveExecutionContext(new Headers({ "x-trestle-tenant": "org-b" }), environment, dependencies({
      findMembership: async (_userId, organizationId) => { selected.push(organizationId); return null; },
    }))).rejects.toMatchObject({ code: "not_found" });
    expect(selected).toEqual(["org-b"]);
  });
});
