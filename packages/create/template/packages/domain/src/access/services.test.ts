import { applicationRoles, verifyApiKey } from "@__TRESTLE_PROJECT_NAME__/authz";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryTenantAccessRepository } from "./in-memory.js";
import type { OperationContext } from "./ports.js";
import { AccessDomainError, applyOrganizationCreatorAssignments, ApplicationRoleService, OrganizationRoleService, ServiceAccountService } from "./services.js";

const now = new Date("2026-09-22T12:00:00Z");
const context: OperationContext = { organizationId: "org-a", actor: { type: "user", id: "user-owner" }, correlationId: "corr-1", environment: "production", now };
let repository: InMemoryTenantAccessRepository;

beforeEach(() => {
  repository = new InMemoryTenantAccessRepository();
  repository.members.push(
    { memberId: "m-owner", userId: "user-owner", name: "Olive", email: "olive@example.test", organizationRoles: ["owner"] },
    { memberId: "m-admin", userId: "user-admin", name: "Ada", email: "ada@example.test", organizationRoles: ["admin"] },
    { memberId: "m-member", userId: "user-member", name: "Mo", email: "mo@example.test", organizationRoles: ["member"] },
  );
});

describe("organization roles", () => {
  const service = () => new OrganizationRoleService(repository);

  it("keeps at least one owner and lets only owners grant or remove ownership", async () => {
    await expect(service().setMemberRoles(context, ["owner"], "m-owner", ["admin"])).rejects.toThrow("at least one owner");
    await expect(service().setMemberRoles({ ...context, actor: { type: "user", id: "user-admin" } }, ["admin"], "m-member", ["owner"])).rejects.toThrow("Only an organization owner");
    await service().setMemberRoles(context, ["owner"], "m-member", ["owner", "member"]);
    await service().setMemberRoles(context, ["owner"], "m-owner", ["admin"]);
    expect(repository.members.find((member) => member.memberId === "m-owner")?.organizationRoles).toEqual(["admin"]);
  });

  it("rejects application roles in the organization plane", async () => {
    await expect(service().setMemberRoles(context, ["owner"], "m-member", ["app_admin"])).rejects.toThrow("Unknown organization roles: app_admin");
  });

  it("audits the change with a safe before/after summary", async () => {
    await service().setMemberRoles(context, ["owner"], "m-member", ["billing_admin"]);
    expect(repository.mutations.at(-1)).toMatchObject({ audit: { name: "access.organization_roles.changed", targetId: "m-member", summary: { before: ["member"], after: ["billing_admin"] }, outcome: "succeeded" }, event: { name: "access.organization_roles.changed" } });
  });
});

describe("application roles", () => {
  const service = () => new ApplicationRoleService(repository);

  it("assigns application roles independently of organization roles", async () => {
    await service().assignUserRoles(context, "user-member", ["editor"]);
    expect((await repository.listApplicationRoleAssignments("user-member")).map(({ role }) => role)).toEqual(["editor"]);
    expect(repository.members.find((member) => member.userId === "user-member")?.organizationRoles).toEqual(["member"]);
    await expect(service().assignUserRoles(context, "user-member", ["owner"])).rejects.toThrow("Unknown application roles: owner");
    await expect(service().assignUserRoles(context, "stranger", ["reader"])).rejects.toThrow("current organization members");
  });

  it("gives an organization owner no application authority without an assignment", async () => {
    expect(await repository.listApplicationRoleAssignments("user-owner")).toEqual([]);
    expect(applicationRoles.resolve((await repository.listApplicationRoleAssignments("user-owner")).map(({ role }) => role)).permissions.size).toBe(0);
  });

  it("validates custom roles against the application plane and revokes their assignments on delete", async () => {
    await expect(service().saveCustomRole(context, { key: "sneaky", name: "Sneaky", permissions: ["organization.members.invite"] }, "create")).rejects.toThrow("cannot grant organization permission");
    await service().saveCustomRole(context, { key: "auditor", name: "Auditor", permissions: ["resource.read"] }, "create");
    await expect(service().saveCustomRole(context, { key: "auditor", name: "Auditor", permissions: [] }, "create")).rejects.toMatchObject({ code: "conflict" });
    await service().assignUserRoles(context, "user-member", ["auditor", "reader"]);
    await service().deleteCustomRole(context, "auditor");
    expect((await repository.listApplicationRoleAssignments("user-member")).map(({ role }) => role)).toEqual(["reader"]);
    await expect(service().deleteCustomRole(context, "editor")).rejects.toThrow("built-in or catalog application role");
  });

  it("applies the explicit organization-creator bootstrap policy once", async () => {
    await applyOrganizationCreatorAssignments(repository, context, "user-owner");
    await applyOrganizationCreatorAssignments(repository, context, "user-owner");
    expect((await repository.listApplicationRoleAssignments("user-owner")).map(({ role }) => role)).toEqual(["app_admin"]);
    expect(repository.mutations.filter((mutation) => mutation.audit.name === "access.bootstrap.applied")).toHaveLength(1);
  });
});

describe("service accounts and API keys", () => {
  const service = () => new ServiceAccountService(repository);

  it("returns the token exactly once and stores only its verifier", async () => {
    const account = await service().create(context, { name: "deploy-bot", applicationRoles: ["editor"] });
    const minted = await service().mintKey(context, account.id, { scopes: ["resource.read"] }, 5);
    const stored = repository.keys.get(minted.key.id)!;
    expect(minted.token!.startsWith(`${minted.key.displayPrefix}_`)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(minted.token!);
    expect(await verifyApiKey(minted.token!, stored.verifier)).toBe(true);
    expect(JSON.stringify(await repository.listApiKeys())).not.toContain(stored.verifier);
    expect(JSON.stringify(repository.mutations)).not.toContain(minted.token!);
    expect(JSON.stringify(repository.mutations)).not.toContain(stored.verifier);
  });

  it("only mints scopes within the service account's application authority", async () => {
    const account = await service().create(context, { name: "reader-bot", applicationRoles: ["reader"] });
    await expect(service().mintKey(context, account.id, { scopes: ["resource.write"] }, 5)).rejects.toThrow("exceeds the service account's permissions");
    await expect(service().mintKey(context, account.id, { scopes: ["organization.api_keys.manage"] }, 5)).rejects.toThrow("cannot be granted to API keys");
    await expect(service().create(context, { name: "owner-bot", applicationRoles: ["owner"] })).rejects.toThrow("Unknown application roles: owner");
    await expect(service().mintKey(context, account.id, { scopes: ["resource.read"], allowedCidrs: ["nope"] }, 5)).rejects.toThrow("CIDR");
  });

  it("enforces the plan's active-key limit", async () => {
    const account = await service().create(context, { name: "bot", applicationRoles: ["reader"] });
    await service().mintKey(context, account.id, { scopes: ["resource.read"] }, 1);
    await expect(service().mintKey(context, account.id, { scopes: ["resource.read"] }, 1)).rejects.toMatchObject<Partial<AccessDomainError>>({ code: "limit_exceeded" });
  });

  it("rotates with a bounded overlap and refuses to rotate twice", async () => {
    const account = await service().create(context, { name: "bot", applicationRoles: ["editor"] });
    const first = await service().mintKey(context, account.id, { scopes: ["resource.read", "resource.write"] }, 1);
    const rotated = await service().rotateKey(context, first.key.id, 24, 1);
    expect(rotated.previous.expiresAt.toISOString()).toBe("2026-09-23T12:00:00.000Z");
    expect(rotated.key).toMatchObject({ scopes: ["resource.read", "resource.write"], rotatedFrom: first.key.id });
    expect(repository.keys.get(first.key.id)).toMatchObject({ rotatedTo: rotated.key.id, expiresAt: rotated.previous.expiresAt });
    await expect(service().rotateKey(context, first.key.id, 24, 1)).rejects.toMatchObject({ code: "conflict" });
    await expect(service().rotateKey(context, rotated.key.id, 500, 5)).rejects.toThrow("Rotation overlap");
  });

  it("requires reasons for revocation and suspension and blocks keys for suspended accounts", async () => {
    const account = await service().create(context, { name: "bot", applicationRoles: ["reader"] });
    const minted = await service().mintKey(context, account.id, { scopes: ["resource.read"] }, null);
    await expect(service().revokeKey(context, minted.key.id, " ")).rejects.toThrow("requires a reason");
    await service().revokeKey(context, minted.key.id, "leaked in CI logs");
    expect(repository.keys.get(minted.key.id)?.revokedAt).toEqual(now);
    await expect(service().setStatus(context, account.id, "suspended", null)).rejects.toThrow("requires a reason");
    await service().setStatus(context, account.id, "suspended", "compromised host");
    await expect(service().mintKey(context, account.id, { scopes: ["resource.read"] }, null)).rejects.toThrow("Suspended");
  });

  it("refuses to narrow roles below the scopes of active keys", async () => {
    const account = await service().create(context, { name: "bot", applicationRoles: ["editor"] });
    await service().mintKey(context, account.id, { scopes: ["resource.write"] }, null);
    await expect(service().setRoles(context, account.id, ["reader"])).rejects.toThrow("resource.write");
  });

  it("audits every mutation with semantic names", async () => {
    const account = await service().create(context, { name: "bot", applicationRoles: ["editor"] });
    const minted = await service().mintKey(context, account.id, { scopes: ["resource.read"] }, null);
    await service().rotateKey(context, minted.key.id, 1, null);
    await service().revokeKey(context, minted.key.id, "done");
    expect(repository.mutations.map((mutation) => mutation.audit.name)).toEqual(["access.service_account.created", "access.api_key.minted", "access.api_key.rotated", "access.api_key.revoked"]);
    expect(repository.mutations.every((mutation) => mutation.context.correlationId === "corr-1" && mutation.event.payload.organizationId === "org-a")).toBe(true);
  });

  it("keeps active names unique, edits metadata, and tombstones deletions with every key revoked", async () => {
    const account = await service().create(context, { name: "Deploy Bot", applicationRoles: ["editor"] });
    await expect(service().create(context, { name: "deploy bot", applicationRoles: ["reader"] })).rejects.toMatchObject({ code: "conflict" });
    await service().update(context, account.id, { name: "Release Bot", description: "Ships releases" });
    expect(repository.accounts.get(account.id)).toMatchObject({ name: "Release Bot", description: "Ships releases" });
    const first = await service().mintKey(context, account.id, { scopes: ["resource.read"] }, null);
    const second = await service().mintKey(context, account.id, { scopes: ["resource.write"] }, null);
    await expect(service().delete(context, account.id, " ")).rejects.toThrow("requires a reason");
    expect(await service().delete(context, account.id, "retired pipeline")).toEqual({ revokedKeys: 2 });
    for (const key of [first, second]) expect(repository.keys.get(key.key.id)?.revokedAt).toEqual(now);
    expect(repository.accounts.get(account.id)?.deletedAt).toEqual(now);
    await expect(service().mintKey(context, account.id, { scopes: ["resource.read"] }, null)).rejects.toMatchObject({ code: "not_found" });
    // The name is free again once the old account is a tombstone.
    await service().create(context, { name: "Release Bot", applicationRoles: ["reader"] });
  });

  it("returns the original key for an idempotent retry and never a second secret", async () => {
    const account = await service().create(context, { name: "retry-bot", applicationRoles: ["editor"] });
    const minted = await service().mintKey(context, account.id, { scopes: ["resource.read"], name: "CI", idempotencyKey: "req-1" }, null);
    const retried = await service().mintKey(context, account.id, { scopes: ["resource.read"], name: "CI", idempotencyKey: "req-1" }, null);
    expect(minted.token).toBeTruthy();
    expect(retried).toMatchObject({ token: null, replayed: true, key: { id: minted.key.id, name: "CI" } });
    expect([...repository.keys.values()].filter((key) => key.serviceAccountId === account.id)).toHaveLength(1);
  });

  it("widens scopes only through a replacement key, never beyond the actor or the account", async () => {
    const account = await service().create(context, { name: "scoped-bot", applicationRoles: ["editor"] });
    const minted = await service().mintKey(context, account.id, { scopes: ["resource.read"] }, null);
    await expect(service().mintKey(context, account.id, { scopes: ["resource.write"], actorAuthority: new Set(["resource.read"]) }, null)).rejects.toThrow("do not hold");
    await expect(service().replaceKey(context, minted.key.id, { scopes: ["workflows.publish"], overlapHours: 1 }, null)).rejects.toThrow("exceeds");
    const replaced = await service().replaceKey(context, minted.key.id, { scopes: ["resource.read", "resource.write"], overlapHours: 1 }, null);
    expect(replaced.key.scopes).toEqual(["resource.read", "resource.write"]);
    expect(repository.keys.get(minted.key.id)).toMatchObject({ scopes: ["resource.read"], rotatedTo: replaced.key.id, replacedBy: replaced.key.id });
    expect(replaced.previous.expiresAt).toEqual(new Date(now.getTime() + 3_600_000));
  });

  it("keeps an archived role a member already holds while other roles change", async () => {
    const account = await service().create(context, { name: "legacy-bot", applicationRoles: ["reader"] });
    repository.accounts.set(account.id, { ...repository.accounts.get(account.id)!, applicationRoles: ["reader", "archived_role"] });
    await service().setRoles(context, account.id, ["reader", "editor", "archived_role"]);
    await expect(service().setRoles(context, account.id, ["reader", "another_unknown"])).rejects.toThrow("Unknown application roles: another_unknown");
  });
});
