import type { EventCatalog, EventPayload } from "@__TRESTLE_PROJECT_NAME__/events";

export type NotificationChannel = "in_app" | "email";
export const notificationChannels: readonly NotificationChannel[] = ["in_app", "email"];

export type NotificationTrigger = Readonly<{
  /** Registered application event that raises this notification. */
  event: string;
  /** Members holding any of these organization roles, and/or explicit users named by the payload. */
  recipients: Readonly<{ organizationRoles?: readonly string[]; userIdFrom?: string }>;
}>;

export type NotificationContent = Readonly<{ title: string; body: string; link?: string }>;

export type NotificationDefinition = Readonly<{
  name: string;
  description: string;
  /** Supported channels and whether each is on by default. */
  channels: Readonly<Partial<Record<NotificationChannel, Readonly<{ default: boolean }>>>>;
  /** Channels recipients cannot turn off, such as security alerts in the inbox. */
  mandatory?: readonly NotificationChannel[];
  trigger?: NotificationTrigger;
  /** Notifications with the same key within the window collapse into one, with a count. */
  group?: Readonly<{ key: (payload: EventPayload) => string; windowMinutes: number }>;
  /** A repeat with the same key within the window is dropped. */
  dedupe?: Readonly<{ key: (payload: EventPayload, resource: Readonly<{ type: string; id: string }>) => string; windowMinutes: number }>;
  render: (payload: EventPayload, count: number) => NotificationContent;
  /** Operator actions the application exposes in platform admin. */
  operatorActions?: Readonly<{ retry?: boolean; cancel?: boolean }>;
  /** False when only organization defaults apply (organization-controlled streams). */
  userConfigurable?: boolean;
  /** parallel (default) sends on every enabled route; fallback emails only when the inbox route is off. */
  strategy?: "parallel" | "fallback";
  /** The published stream version this definition came from; absent for code definitions. */
  streamVersion?: number;
  delayMinutes?: number;
  /** Extra delay on email so a digest window can collect grouped notifications. */
  emailDelayMinutes?: number;
  /** Which recipient forms a send may use; absent means any. */
  recipientKinds?: readonly ("user" | "organization_role")[];
  /** Send-time data validation; problems make the send fail visibly. */
  validate?: (payload: EventPayload) => string[];
}>;

export type NotificationCatalog = Readonly<{
  get(type: string): (NotificationDefinition & { type: string }) | undefined;
  list(): Array<NotificationDefinition & { type: string }>;
  triggeredBy(event: string): Array<NotificationDefinition & { type: string }>;
}>;

export class NotificationDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationDefinitionError";
  }
}

export function defineNotifications(events: EventCatalog, definitions: Readonly<Record<string, NotificationDefinition>>): NotificationCatalog {
  const entries = Object.entries(definitions).map(([type, definition]) => {
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u.test(type)) throw new NotificationDefinitionError(`Notification type ${type} must be a lowercase dotted name`);
    const supported = Object.keys(definition.channels) as NotificationChannel[];
    if (supported.length === 0) throw new NotificationDefinitionError(`Notification ${type} must support at least one channel`);
    for (const channel of supported) if (!notificationChannels.includes(channel)) throw new NotificationDefinitionError(`Notification ${type} uses unknown channel ${channel}`);
    for (const channel of definition.mandatory ?? []) if (!supported.includes(channel)) throw new NotificationDefinitionError(`Notification ${type} makes unsupported channel ${channel} mandatory`);
    if (definition.trigger && !events.has(definition.trigger.event)) throw new NotificationDefinitionError(`Notification ${type} is triggered by unregistered event ${definition.trigger.event}`);
    return { ...definition, type };
  });
  return {
    get: (type) => entries.find((entry) => entry.type === type),
    list: () => [...entries],
    triggeredBy: (event) => entries.filter((entry) => entry.trigger?.event === event),
  };
}

export type PreferenceSource = "mandatory" | "user" | "organization" | "default";
export type ResolvedPreference = Readonly<{ enabled: boolean; source: PreferenceSource; mandatory: boolean }>;

/** Mandatory beats the user's choice, which beats the organization default, which beats the definition default. */
export function resolvePreference(definition: NotificationDefinition, channel: NotificationChannel, choices: Readonly<{ user?: boolean | undefined; organization?: boolean | undefined }>): ResolvedPreference | null {
  const supported = definition.channels[channel];
  if (!supported) return null;
  if (definition.mandatory?.includes(channel)) return { enabled: true, source: "mandatory", mandatory: true };
  if (choices.user !== undefined && definition.userConfigurable !== false) return { enabled: choices.user, source: "user", mandatory: false };
  if (choices.organization !== undefined) return { enabled: choices.organization, source: "organization", mandatory: false };
  return { enabled: supported.default, source: "default", mandatory: false };
}

/** Email retries: after 1 and 5 minutes, then the delivery fails. */
export const emailRetrySchedule: readonly number[] = [60, 300];
