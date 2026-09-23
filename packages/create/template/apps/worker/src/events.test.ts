import { defineEvent, defineEventCatalog } from "@__TRESTLE_PROJECT_NAME__/events";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createEventPublisher } from "./events.js";

const payload = z.object({ articleId: z.string().min(1), title: z.string().min(1) });
const catalog = defineEventCatalog([defineEvent({
  name: "article.published", schemaVersion: 2, description: "An article was published",
  sensitivity: "internal", payload,
  resource: { type: "article", id: (value: z.infer<typeof payload>) => value.articleId },
})]);
const dialect = new PgDialect();

describe("transactional application event publisher", () => {
  it("builds a tenant-bound, catalog-validated insert for the caller's transaction", () => {
    const events = createEventPublisher({ organizationId: "org_a", correlationId: "correlation-1", catalog,
      clock: { now: () => new Date("2026-09-23T12:00:00.000Z") } });
    const query = dialect.sqlToQuery(events.statement("article.published", { articleId: "article-1", title: "Ready" },
      { schemaVersion: 2, idempotencyKey: "publish:article-1", causationId: "request-1" }));
    expect(query.sql).toContain("insert into outbox_message");
    expect(query.sql).toContain("organization_id");
    expect(query.sql).toContain("on conflict (idempotency_key) do nothing");
    expect(query.params).toContain("org_a");
    expect(query.params).toContain("correlation-1");
    expect(query.params).toContain("org_a:publish:article-1");
    expect(query.params).toContain("request-1");
    expect(query.params).toContain(2);
    expect(query.params.filter((value) => value === "2026-09-23T12:00:00.000Z")).toHaveLength(2);
    expect(query.params).toContain(JSON.stringify({ articleId: "article-1", title: "Ready" }));
    expect(query.params).not.toContain("other-org");
    const otherTenant = createEventPublisher({ organizationId: "org_b", correlationId: "correlation-1", catalog });
    const otherQuery = dialect.sqlToQuery(otherTenant.statement("article.published", { articleId: "article-1", title: "Ready" },
      { schemaVersion: 2, idempotencyKey: "publish:article-1" }));
    expect(otherQuery.params).toContain("org_b:publish:article-1");
    expect(otherQuery.params).not.toContain("org_a:publish:article-1");
  });

  it("rejects unregistered events, invalid payloads, and missing idempotency before persistence", () => {
    const events = createEventPublisher({ organizationId: "org_a", correlationId: "correlation-1", catalog });
    expect(() => events.statement("article.published", { articleId: "article-1", title: "Ready" }, { idempotencyKey: "key" })).toThrow("not registered");
    expect(() => events.statement("article.deleted", {}, { idempotencyKey: "key" })).toThrow("not registered");
    expect(() => events.statement("article.published", { articleId: "article-1" }, { schemaVersion: 2, idempotencyKey: "key" })).toThrow("Internal event payload fails");
    expect(() => events.statement("article.published", { articleId: "article-1", title: "Ready" }, { schemaVersion: 2, idempotencyKey: " " })).toThrow("idempotency key");
    expect(() => createEventPublisher({ organizationId: "invalid tenant", correlationId: "c", catalog })).toThrow("organization identifier");
  });
});
