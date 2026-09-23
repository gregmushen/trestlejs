import type { EventPayload } from "@__TRESTLE_PROJECT_NAME__/events";

import type { Mutation, OperationContext } from "../access/ports.js";
import { emailRetrySchedule, notificationChannels, resolvePreference, type NotificationCatalog, type NotificationChannel, type ResolvedPreference } from "./model.js";
import type { NotificationDeliveryRecord, NotificationRecord, NotificationRepository } from "./ports.js";

export class NotificationError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "conflict", message: string) {
    super(message);
    this.name = "NotificationError";
  }
}

export type NotificationEmailSender = (message: Readonly<{ to: string; title: string; body: string; link: string | null }>, options: Readonly<{ organizationId: string; correlationId: string; idempotencyKey: string }>) => Promise<{ id: string }>;

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;

export type PreferenceView = Readonly<{
  type: string;
  name: string;
  description: string;
  channels: Array<Readonly<{ channel: NotificationChannel } & ResolvedPreference & { organizationDefault: boolean | null }>>;
}>;

/**
 * Raises, groups, and delivers application notifications. The inbox is the
 * in-app channel; email goes through the application's email boundary.
 */
export class NotificationService {
  constructor(private readonly repository: NotificationRepository, private readonly catalog: NotificationCatalog) {}

  /** Raises every notification triggered by a committed application event. */
  async fromEvent(context: OperationContext, event: Readonly<{ id: string; name: string; resource: { type: string; id: string }; payload: EventPayload }>): Promise<number> {
    let created = 0;
    for (const definition of this.catalog.triggeredBy(event.name)) {
      const selector = definition.trigger!.recipients;
      const fromPayload = selector.userIdFrom ? event.payload[selector.userIdFrom] : undefined;
      const recipients = await this.repository.recipients({ ...(selector.organizationRoles ? { organizationRoles: selector.organizationRoles } : {}), ...(typeof fromPayload === "string" ? { userIds: [fromPayload] } : {}) });
      created += await this.raise(context, definition.type, recipients.map((recipient) => recipient.userId), event.payload, event);
    }
    return created;
  }

  async raise(context: OperationContext, type: string, userIds: readonly string[], payload: EventPayload, source?: Readonly<{ id: string; resource: { type: string; id: string } }>, options: Readonly<{ test?: boolean }> = {}): Promise<number> {
    const definition = this.catalog.get(type);
    if (!definition) {
      const archived = (this.catalog as { archived?: ReadonlySet<string> }).archived?.has(type);
      throw new NotificationError(archived ? "conflict" : "not_found", archived ? `Notification stream ${type} is archived` : `Notification type ${type} is not defined`);
    }
    const problems = definition.validate?.(payload) ?? [];
    if (problems.length) throw new NotificationError("invalid", `${type}: ${problems.join("; ")}`);
    const visibleAt = new Date(context.now.getTime() + (definition.delayMinutes ?? 0) * 60_000);
    const emailAt = new Date(visibleAt.getTime() + (definition.emailDelayMinutes ?? 0) * 60_000);
    const preferences = await this.repository.preferences(userIds);
    const choice = (userId: string, channel: NotificationChannel) => preferences.find((row) => row.userId === userId && row.type === type && row.channel === channel)?.enabled;
    const resource = source?.resource ?? { type: "notification", id: type };
    let created = 0;
    for (const userId of new Set(userIds)) {
      // Marked tests bypass deduplication and grouping so every test is visible.
      const dedupeKey = options.test ? undefined : definition.dedupe?.key(payload, resource);
      if (dedupeKey && await this.repository.findRecent(userId, type, { dedupeKey }, new Date(context.now.getTime() - definition.dedupe!.windowMinutes * 60_000))) continue;
      const groupKey = options.test ? null : definition.group?.key(payload) ?? null;
      const open = groupKey ? await this.repository.findRecent(userId, type, { groupKey }, new Date(context.now.getTime() - definition.group!.windowMinutes * 60_000)) : null;
      if (open && !open.readAt) {
        // Grouped into the unread notification already in the inbox; no further email is sent.
        const content = definition.render(payload, open.groupCount + 1);
        await this.repository.regroup(open.id, { title: content.title, body: content.body, link: content.link ?? null }, open.groupCount + 1, context.now);
        continue;
      }
      const rendered = definition.render(payload, 1);
      const content = options.test ? { ...rendered, title: `[Test] ${rendered.title}` } : rendered;
      const notification: NotificationRecord = {
        id: id("ntf"), userId, type, title: content.title, body: content.body, link: content.link ?? null, groupKey, groupCount: 1, dedupeKey: dedupeKey ?? null,
        eventId: options.test ? `test:${context.correlationId}` : source?.id ?? null, correlationId: context.correlationId, createdAt: context.now, updatedAt: context.now, readAt: null,
        scheduledAt: visibleAt, streamVersion: definition.streamVersion ?? null,
      };
      const resolvedChannels = notificationChannels.flatMap((channel) => {
        const resolved = resolvePreference(definition, channel, { user: choice(userId, channel), organization: choice("*", channel) });
        return resolved ? [{ channel, resolved }] : [];
      });
      const inboxOn = resolvedChannels.some((entry) => entry.channel === "in_app" && entry.resolved.enabled);
      const deliveries = resolvedChannels.map(({ channel, resolved }) => {
        // Fallback: email only when the recipient's inbox route is off.
        const skippedByFallback = definition.strategy === "fallback" && channel === "email" && inboxOn && !resolved.mandatory;
        // The inbox entry is the in-app delivery; it is complete once written.
        const status = !resolved.enabled || skippedByFallback ? "skipped" as const : channel === "in_app" ? "sent" as const : "pending" as const;
        return { id: id("ntd"), notificationId: notification.id, userId, channel, status, preferenceSource: resolved.source, mandatory: resolved.mandatory, attempts: 0, failureCategory: skippedByFallback ? "fallback_not_needed" : null, emailDeliveryId: null, correlationId: context.correlationId, ...(channel === "email" ? { nextAttemptAt: emailAt } : {}) };
      });
      await this.repository.insert(notification, deliveries);
      created += 1;
    }
    return created;
  }

  async deliverEmail(deliveryId: string, send: NotificationEmailSender, context: OperationContext): Promise<NotificationDeliveryRecord["status"] | "skipped"> {
    const delivery = await this.repository.delivery(deliveryId);
    if (!delivery || delivery.status !== "pending" || delivery.channel !== "email") return "skipped";
    if (!delivery.recipientEmail) { await this.repository.completeDelivery(delivery.id, { status: "failed", failureCategory: "no_recipient_address", emailDeliveryId: null, nextAttemptAt: null }, context.now); return "failed"; }
    try {
      const receipt = await send({ to: delivery.recipientEmail, ...delivery.content }, { organizationId: context.organizationId, correlationId: delivery.correlationId, idempotencyKey: `${delivery.id}:${delivery.attempts + 1}` });
      await this.repository.completeDelivery(delivery.id, { status: "sent", failureCategory: null, emailDeliveryId: receipt.id, nextAttemptAt: null }, context.now);
      return "sent";
    } catch (error) {
      const retryIn = emailRetrySchedule[delivery.attempts];
      const category = error instanceof Error && /rate/iu.test(error.name) ? "rate_limited" : error instanceof Error && /reject|validation/iu.test(error.name) ? "rejected" : "provider_unavailable";
      await this.repository.completeDelivery(delivery.id, { status: retryIn === undefined || category === "rejected" ? "failed" : "pending", failureCategory: category, emailDeliveryId: null, nextAttemptAt: retryIn === undefined ? null : new Date(context.now.getTime() + retryIn * 1_000) }, context.now);
      return retryIn === undefined ? "failed" : "pending";
    }
  }

  /**
   * `ctx.notifications.send`: resolves the type (a code definition or the
   * active stream version), checks the recipient form and data, and raises it.
   */
  async send(context: OperationContext, input: Readonly<{ type: string; recipient: Readonly<{ userId: string } | { userIds: readonly string[] } | { organizationRole: string }>; data: EventPayload }>, options: Readonly<{ test?: boolean }> = {}): Promise<{ created: number; streamVersion: number | null }> {
    const definition = this.catalog.get(input.type);
    const kind = "organizationRole" in input.recipient ? "organization_role" : "user";
    if (definition?.recipientKinds && !definition.recipientKinds.includes(kind)) throw new NotificationError("invalid", `${input.type} cannot be sent to ${kind === "user" ? "individual users" : "organization roles"}`);
    const userIds = "userId" in input.recipient ? [input.recipient.userId] : "userIds" in input.recipient ? [...input.recipient.userIds]
      : (await this.repository.recipients({ organizationRoles: [input.recipient.organizationRole] })).map((recipient) => recipient.userId);
    const members = new Set((await this.repository.recipients({ userIds })).map((recipient) => recipient.userId));
    const outsiders = userIds.filter((userId) => !members.has(userId));
    if (outsiders.length) throw new NotificationError("invalid", "Notifications can only be sent to members of this organization");
    const created = await this.raise(context, input.type, userIds, input.data, undefined, options);
    return { created, streamVersion: definition?.streamVersion ?? null };
  }

  async inbox(userId: string, limit = 50) {
    return { notifications: await this.repository.inbox(userId, limit), unread: await this.repository.unreadCount(userId) };
  }

  async markRead(userId: string, ids: readonly string[] | "all", now: Date) {
    return await this.repository.markRead(userId, ids, now);
  }

  /** Effective preferences for one member, with where each value comes from. */
  async preferences(userId: string): Promise<PreferenceView[]> {
    const rows = await this.repository.preferences([userId]);
    return this.catalog.list().map((definition) => ({
      type: definition.type, name: definition.name, description: definition.description,
      channels: notificationChannels.flatMap((channel) => {
        const organization = rows.find((row) => row.userId === "*" && row.type === definition.type && row.channel === channel)?.enabled;
        const resolved = resolvePreference(definition, channel, { user: rows.find((row) => row.userId === userId && row.type === definition.type && row.channel === channel)?.enabled, organization });
        return resolved ? [{ channel, ...resolved, organizationDefault: organization ?? null }] : [];
      }),
    }));
  }

  private configurable(type: string, channel: NotificationChannel) {
    const definition = this.catalog.get(type);
    if (!definition || !definition.channels[channel]) throw new NotificationError("invalid", `${type} does not support the ${channel} channel`);
    if (definition.mandatory?.includes(channel)) throw new NotificationError("conflict", `${definition.name} is mandatory in ${channel === "in_app" ? "the inbox" : "email"}`);
    return definition;
  }

  async setUserPreference(userId: string, type: string, channel: NotificationChannel, enabled: boolean | null): Promise<void> {
    if (this.configurable(type, channel).userConfigurable === false) throw new NotificationError("conflict", "Your organization controls this notification");
    if (enabled === null) await this.repository.clearPreference(userId, type, channel);
    else await this.repository.setPreference({ userId, type, channel, enabled }, userId);
  }

  /** Organization defaults apply to members who have not chosen for themselves. */
  async setOrganizationDefault(context: OperationContext, type: string, channel: NotificationChannel, enabled: boolean | null): Promise<void> {
    this.configurable(type, channel);
    const audit: Mutation = {
      context, audit: { name: "notifications.default.changed", targetType: "notification_type", targetId: type, summary: { channel, enabled }, outcome: "succeeded" },
      event: { name: "notifications.default.changed", resourceType: "notification_type", resourceId: type, payload: { organizationId: context.organizationId, channel, enabled } },
    };
    if (enabled === null) await this.repository.clearPreference("*", type, channel, audit);
    else await this.repository.setPreference({ userId: "*", type, channel, enabled }, context.actor.id, audit);
  }
}
