import { describe, expect, it } from "vitest";

import type { OperationContext } from "../access/ports.js";
import { notifications } from "./definitions.js";
import type { NotificationDeliveryRecord, NotificationRecord, NotificationRepository, PreferenceRow } from "./ports.js";
import { NotificationService } from "./service.js";
import { composeNotificationCatalog, defaultStreamDefinition, renderTemplate, streamDataProblems, streamDefinitionProblems, type StreamDefinition, type StreamVersionRecord } from "./streams.js";

const invoiceReady: StreamDefinition = {
  ...defaultStreamDefinition,
  inputs: [{ name: "invoiceId", type: "string", required: true }, { name: "amount", type: "number", required: false }],
  routes: { in_app: { default: true }, email: { default: true } },
  templates: { title: "Invoice {{invoiceId}} is ready", body: "Amount: {{amount}}", link: "/invoices/{{invoiceId}}" },
};
const stream = (definition: StreamDefinition, version = 2): StreamVersionRecord => ({ type: "billing.invoice_ready", name: "Invoice ready", description: "", version, state: "active", definition });

class FakeRepository implements Partial<NotificationRepository> {
  inserted: Array<{ notification: NotificationRecord; deliveries: ReadonlyArray<Pick<NotificationDeliveryRecord, "channel" | "status" | "failureCategory">> }> = [];
  constructor(private readonly members: string[], private readonly rows: PreferenceRow[] = []) {}
  async recipients(selector: { organizationRoles?: readonly string[]; userIds?: readonly string[] }) {
    return (selector.userIds ?? this.members).filter((userId) => this.members.includes(userId)).map((userId) => ({ userId, name: userId, email: `${userId}@example.com` }));
  }
  async preferences() { return this.rows; }
  async findRecent() { return null; }
  async insert(notification: NotificationRecord, deliveries: ReadonlyArray<Pick<NotificationDeliveryRecord, "channel" | "status" | "failureCategory">>) { this.inserted.push({ notification, deliveries }); }
}

const context: OperationContext = { organizationId: "org_1", actor: { type: "user", id: "usr_admin" }, correlationId: "cor_1", environment: "local", now: new Date("2026-09-01T00:00:00Z") };
const service = (repository: FakeRepository, definition = invoiceReady, archived: string[] = []) => new NotificationService(repository as unknown as NotificationRepository, composeNotificationCatalog(notifications, [stream(definition)], archived));

describe("notification streams", () => {
  it("reports every problem that blocks publishing", () => {
    expect(streamDefinitionProblems(invoiceReady)).toEqual([]);
    const problems = streamDefinitionProblems({ ...invoiceReady, recipients: [], routes: { in_app: { default: true } }, strategy: "fallback", templates: { title: "{{missing}}", body: "", link: "http://insecure" }, digestMinutes: 30 });
    expect(problems).toEqual(expect.arrayContaining([
      "Allow at least one recipient kind", "Fallback delivery needs both the inbox and email routes", "A body template is required",
      "The title template uses {{missing}}, which is not a declared input", "A digest needs a grouping key so notifications can be batched", "A digest batches email; enable the email route",
      "Links must be application paths (/…) or https:// URLs",
    ]));
  });

  it("validates send data against the declared inputs and renders it as plain text", () => {
    expect(streamDataProblems(invoiceReady, { invoiceId: "in_1", amount: 12 })).toEqual([]);
    expect(streamDataProblems(invoiceReady, { amount: "12", extra: true })).toEqual(["invoiceId is required", "amount must be a number", "extra is not an input of this stream"]);
    expect(renderTemplate("Hi {{ name }} <b>{{x}}</b>", { name: "<script>" })).toBe("Hi <script> <b></b>");
  });

  it("never lets a stream shadow a code-defined type", () => {
    const code = notifications.list()[0]!;
    const catalog = composeNotificationCatalog(notifications, [{ ...stream(invoiceReady), type: code.type, name: "Shadow" }]);
    expect(catalog.get(code.type)?.name).toBe(code.name);
  });

  it("sends through the active version and records it", async () => {
    const repository = new FakeRepository(["usr_1"]);
    await expect(service(repository).send(context, { type: "billing.invoice_ready", recipient: { userId: "usr_1" }, data: { invoiceId: "in_1", amount: 5 } })).resolves.toEqual({ created: 1, streamVersion: 2 });
    expect(repository.inserted[0]!.notification).toMatchObject({ title: "Invoice in_1 is ready", link: "/invoices/in_1", streamVersion: 2 });
  });

  it("fails visibly for missing, archived, invalid, and non-member sends", async () => {
    const repository = new FakeRepository(["usr_1"]);
    await expect(service(repository).send(context, { type: "billing.unknown", recipient: { userId: "usr_1" }, data: {} })).rejects.toThrow(/not defined/u);
    const archived = new NotificationService(repository as unknown as NotificationRepository, composeNotificationCatalog(notifications, [], ["billing.invoice_ready"]));
    await expect(archived.send(context, { type: "billing.invoice_ready", recipient: { userId: "usr_1" }, data: { invoiceId: "in_1" } })).rejects.toThrow(/archived/u);
    await expect(service(repository).send(context, { type: "billing.invoice_ready", recipient: { userId: "usr_1" }, data: {} })).rejects.toThrow(/invoiceId is required/u);
    await expect(service(repository).send(context, { type: "billing.invoice_ready", recipient: { userId: "usr_outsider" }, data: { invoiceId: "in_1" } })).rejects.toThrow(/members of this organization/u);
    await expect(service(repository).send(context, { type: "billing.invoice_ready", recipient: { organizationRole: "admin" }, data: { invoiceId: "in_1" } })).rejects.toThrow(/organization roles/u);
    expect(repository.inserted).toHaveLength(0);
  });

  it("skips email under fallback when the inbox route is on, and marks tests", async () => {
    const repository = new FakeRepository(["usr_1"]);
    await service(repository, { ...invoiceReady, strategy: "fallback" }).send(context, { type: "billing.invoice_ready", recipient: { userId: "usr_1" }, data: { invoiceId: "in_1" } }, { test: true });
    const [entry] = repository.inserted;
    expect(entry!.notification.title).toBe("[Test] Invoice in_1 is ready");
    expect(entry!.deliveries.find((delivery) => delivery.channel === "email")).toMatchObject({ status: "skipped", failureCategory: "fallback_not_needed" });
  });

  it("ignores member choices on organization-controlled streams", async () => {
    const repository = new FakeRepository(["usr_1"], [{ userId: "usr_1", type: "billing.invoice_ready", channel: "email", enabled: false }]);
    await service(repository, { ...invoiceReady, policy: "organization" }).send(context, { type: "billing.invoice_ready", recipient: { userId: "usr_1" }, data: { invoiceId: "in_1" } });
    expect(repository.inserted[0]!.deliveries.find((delivery) => delivery.channel === "email")?.status).toBe("pending");
  });
});
