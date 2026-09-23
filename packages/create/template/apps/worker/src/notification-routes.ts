import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { notificationChannels } from "@__TRESTLE_PROJECT_NAME__/domain";
import type { Hono } from "hono";
import { z } from "zod";

import { communicationDependencies, communicationsEnabled, notificationService } from "./communications.js";
import type { AppVariables } from "./execution-context.js";
import { operationContext } from "./webhook-routes.js";

type Environment = { Bindings: AuthEnvironment; Variables: AppVariables };

const preference = z.object({ type: z.string().min(1), channel: z.enum(notificationChannels as unknown as ["in_app", "email"]), enabled: z.boolean().nullable() }).strict();

/** Inbox, preferences, and organization delivery history (docs/ADMIN_ADDITIONS_SPEC.md §2). */
export function registerNotificationRoutes(routes: Hono<Environment>) {
  for (const path of ["/api/tenant/notifications", "/api/tenant/notifications/*", "/api/tenant/notification-preferences", "/api/tenant/notification-defaults", "/api/tenant/notification-deliveries"]) {
    routes.use(path, async (context, next) => {
      if (!communicationsEnabled.notifications) return context.json({ error: "not_enabled", message: "Notifications are not enabled for this application" }, 404);
      // A member's inbox belongs to a human user; machine and support principals have none.
      if (context.get("execution").principal.kind !== "user" && /^\/api\/tenant\/notification(?:s|-preferences)/u.test(context.req.path)) return context.json({ error: "forbidden", message: "Only members have a notification inbox" }, 403);
      await next();
    });
  }

  routes.get("/api/tenant/notifications", async (context) => {
    const execution = context.get("execution");
    const inbox = await (await notificationService(context.env, execution.tenant.organizationId)).inbox(execution.principal.id, Number(context.req.query("limit") ?? 50));
    return context.json({
      unread: inbox.unread,
      notifications: inbox.notifications.map((entry) => ({ id: entry.id, type: entry.type, title: entry.title, body: entry.body, link: entry.link, count: entry.groupCount, createdAt: entry.createdAt.toISOString(), updatedAt: entry.updatedAt.toISOString(), readAt: entry.readAt?.toISOString() ?? null })),
    });
  });

  routes.post("/api/tenant/notifications/read", async (context) => {
    const execution = context.get("execution");
    const input = z.object({ ids: z.union([z.array(z.string()).min(1).max(200), z.literal("all")]) }).strict().parse(await context.req.json().catch(() => ({})));
    return context.json({ marked: await (await notificationService(context.env, execution.tenant.organizationId)).markRead(execution.principal.id, input.ids, execution.clock.now()) });
  });

  routes.get("/api/tenant/notification-preferences", async (context) => {
    const execution = context.get("execution");
    return context.json({ types: await (await notificationService(context.env, execution.tenant.organizationId)).preferences(execution.principal.id), canManageDefaults: execution.access.check({ permission: "organization.notifications.manage" }) });
  });

  routes.put("/api/tenant/notification-preferences", async (context) => {
    const execution = context.get("execution");
    const input = preference.parse(await context.req.json().catch(() => ({})));
    await (await notificationService(context.env, execution.tenant.organizationId)).setUserPreference(execution.principal.id, input.type, input.channel, input.enabled);
    return context.body(null, 204);
  });

  routes.put("/api/tenant/notification-defaults", async (context) => {
    const execution = context.get("execution");
    const input = preference.parse(await context.req.json().catch(() => ({})));
    await (await notificationService(context.env, execution.tenant.organizationId)).setOrganizationDefault(operationContext(execution), input.type, input.channel, input.enabled);
    return context.body(null, 204);
  });

  /** Organization-wide history: delivery metadata only, never message content. */
  routes.get("/api/tenant/notification-deliveries", async (context) => {
    const execution = context.get("execution");
    const [deliveries, members] = await Promise.all([
      communicationDependencies.notificationRepository(context.env, execution.tenant.organizationId).deliveries({ limit: 200 }),
      communicationDependencies.notificationRepository(context.env, execution.tenant.organizationId).recipients({ organizationRoles: ["owner", "admin", "billing_admin", "member"] }),
    ]);
    return context.json({ deliveries: deliveries.map((delivery) => ({ id: delivery.id, type: delivery.type, recipient: members.find((member) => member.userId === delivery.userId)?.name ?? "Former member", channel: delivery.channel, status: delivery.status, preference: delivery.preferenceSource, attempts: delivery.attempts, failureCategory: delivery.failureCategory, correlationId: delivery.correlationId, createdAt: delivery.createdAt.toISOString(), completedAt: delivery.completedAt?.toISOString() ?? null })) });
  });
}
