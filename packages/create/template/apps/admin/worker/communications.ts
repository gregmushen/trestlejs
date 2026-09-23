import { notifications, replayProblem, type EndpointState } from "@__TRESTLE_PROJECT_NAME__/domain";
import { PlatformRequestError, type PlatformAuthority, type PlatformRepository } from "@__TRESTLE_PROJECT_NAME__/platform";
import type { Context, Hono } from "hono";

type Environment = { Bindings: never; Variables: { authority: PlatformAuthority; correlationId: string } };

export type CommunicationDependencies = Readonly<{
  repository: (environment: never) => PlatformRepository;
  audit: (context: Context<Environment>, entry: Readonly<{ name: string; organizationId: string | null; targetType: string; targetId: string; reason: string; summary: Record<string, unknown> }>) => Parameters<PlatformRepository["mutate"]>[1];
}>;

const reasonOf = async (context: Context<Environment>) => (await context.req.json().catch(() => ({})) as { reason?: unknown }).reason;

/**
 * Integrations -> Webhook Delivery and Communications -> Notifications
 * (docs/ADMIN_ADDITIONS_SPEC.md §1-2). Read models carry health, status, and
 * correlation only: never signing secrets, raw URLs, payloads, or message
 * content. Emergency actions need their own permission, a reason, and step-up.
 */
export function registerCommunicationRoutes(admin: Hono<Environment>, dependencies: CommunicationDependencies) {
  admin.get("/api/admin/webhooks", async (context) => {
    context.get("authority").require("platform.webhooks.read");
    const organizationId = context.req.query("organizationId");
    const state = context.req.query("state");
    const q = context.req.query("q");
    const includeDeleted = context.req.query("deleted") === "1";
    return context.json({ endpoints: await dependencies.repository(context.env).webhookEndpoints({ ...(organizationId ? { organizationId } : {}), ...(state ? { state } : {}), ...(q ? { q } : {}), includeDeleted }) });
  });

  admin.get("/api/admin/webhooks/:id/deliveries", async (context) => {
    context.get("authority").require("platform.webhooks.read");
    return context.json({ deliveries: await dependencies.repository(context.env).webhookDeliveries(context.req.param("id")) });
  });

  admin.post("/api/admin/webhooks/:id/disable", async (context) => {
    const authority = context.get("authority");
    const reason = authority.requireSensitive("platform.webhooks.disable", await reasonOf(context));
    const repository = dependencies.repository(context.env);
    const [endpoint] = await repository.webhookEndpoints({ id: context.req.param("id") });
    if (!endpoint) throw new PlatformRequestError(404, "not_found", "Webhook endpoint not found");
    if (endpoint.state === "disabled") throw new PlatformRequestError(409, "conflict", "The endpoint is already disabled");
    await repository.mutate(repository.disableWebhookEndpoint(endpoint.id, authority.operator.id, reason), dependencies.audit(context, { name: "platform.webhook_endpoint.disabled", organizationId: endpoint.organizationId, targetType: "webhook_endpoint", targetId: endpoint.id, reason, summary: { url: endpoint.url, previousState: endpoint.state, pendingCancelled: endpoint.pending } }));
    return context.json({ succeeded: [endpoint.id] });
  });

  admin.post("/api/admin/webhook-deliveries/:id/replay", async (context) => {
    const authority = context.get("authority");
    const reason = authority.requireSensitive("platform.webhooks.replay", await reasonOf(context));
    const repository = dependencies.repository(context.env);
    const delivery = await repository.webhookDelivery(context.req.param("id"));
    if (!delivery) throw new PlatformRequestError(404, "not_found", "Delivery not found");
    const problem = replayProblem({ status: delivery.status as never, test: delivery.test }, delivery.endpointState as EndpointState);
    if (problem) throw new PlatformRequestError(409, "not_replayable", problem);
    const replayId = `whd_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    await repository.mutate(repository.replayWebhookDelivery(delivery.id, replayId, context.get("correlationId")), dependencies.audit(context, { name: "platform.webhook_delivery.replayed", organizationId: delivery.organizationId, targetType: "webhook_delivery", targetId: delivery.id, reason, summary: { replayId, event: delivery.event } }));
    return context.json({ succeeded: [replayId] }, 201);
  });

  admin.get("/api/admin/notifications", async (context) => {
    context.get("authority").require("platform.notifications.read");
    const organizationId = context.req.query("organizationId");
    const status = context.req.query("status");
    const type = context.req.query("type");
    return context.json({
      notifications: await dependencies.repository(context.env).notifications({ ...(organizationId ? { organizationId } : {}), ...(status ? { status } : {}), ...(type ? { type } : {}) }),
      types: notifications.list().map((definition) => ({ type: definition.type, name: definition.name, channels: Object.keys(definition.channels), mandatory: definition.mandatory ?? [], operatorActions: definition.operatorActions ?? {} })),
    });
  });

  admin.get("/api/admin/notifications/:id", async (context) => {
    context.get("authority").require("platform.notifications.read");
    const detail = await dependencies.repository(context.env).notificationDetail(context.req.param("id"));
    if (!detail) return context.json({ error: "not_found", message: "Notification not found" }, 404);
    const definition = notifications.get(detail.notification.type);
    return context.json({ ...detail, definition: definition ? { name: definition.name, group: definition.group ? { windowMinutes: definition.group.windowMinutes } : null, dedupe: definition.dedupe ? { windowMinutes: definition.dedupe.windowMinutes } : null, mandatory: definition.mandatory ?? [], operatorActions: definition.operatorActions ?? {} } : null });
  });

  for (const action of ["retry", "cancel"] as const) {
    admin.post(`/api/admin/notification-deliveries/:id/${action}`, async (context) => {
      const authority = context.get("authority");
      const reason = authority.requireSensitive("platform.notifications.manage", await reasonOf(context));
      const repository = dependencies.repository(context.env);
      const delivery = await repository.notificationDelivery(context.req.param("id"));
      if (!delivery) throw new PlatformRequestError(404, "not_found", "Delivery not found");
      // Operators may only use actions the application exposes for this notification type.
      if (!notifications.get(delivery.type)?.operatorActions?.[action]) throw new PlatformRequestError(409, "action_unavailable", `The application does not expose ${action} for ${delivery.type}`);
      if (action === "retry" && delivery.status !== "failed") throw new PlatformRequestError(409, "not_eligible", "Only failed deliveries can be retried");
      if (action === "cancel" && (delivery.status !== "pending" || delivery.mandatory)) throw new PlatformRequestError(409, "not_eligible", "Only pending, optional deliveries can be cancelled");
      await repository.mutate(action === "retry" ? repository.retryNotificationDelivery(delivery.id) : repository.cancelNotificationDelivery(delivery.id), dependencies.audit(context, { name: `platform.notification_delivery.${action === "retry" ? "retried" : "cancelled"}`, organizationId: delivery.organizationId, targetType: "notification_delivery", targetId: delivery.id, reason, summary: { type: delivery.type, channel: delivery.channel } }));
      return context.json({ succeeded: [delivery.id] });
    });
  }
}
