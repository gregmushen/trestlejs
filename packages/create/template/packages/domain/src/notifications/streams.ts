import type { EventPayload } from "@__TRESTLE_PROJECT_NAME__/events";

import type { NotificationCatalog, NotificationChannel, NotificationDefinition } from "./model.js";

/**
 * Notification streams (docs/ADMIN_REQUIRED_CHANGES.md §8.1): the stable
 * contract behind `ctx.notifications.send({ type, recipient, data })`,
 * defined in the admin as data. A type key is immutable; each published
 * version is immutable; sends record the version they resolved. Code-defined
 * notification types stay authoritative for their keys and are read-only here.
 */

export type StreamInput = Readonly<{ name: string; type: "string" | "number" | "boolean" | "url"; required: boolean }>;
export type RecipientKind = "user" | "organization_role";

export type StreamDefinition = Readonly<{
  inputs: readonly StreamInput[];
  recipients: readonly RecipientKind[];
  routes: Readonly<Partial<Record<NotificationChannel, Readonly<{ default: boolean }>>>>;
  /** parallel: every enabled route; fallback: email only when the inbox route is off for the recipient. */
  strategy: "parallel" | "fallback";
  /** user: members choose; organization: only the organization default applies; mandatory: nobody opts out. */
  policy: "user" | "organization" | "mandatory";
  templates: Readonly<{ title: string; body: string; link?: string }>;
  grouping?: Readonly<{ key: string; windowMinutes: number }> | null;
  dedupe?: Readonly<{ key: string; windowMinutes: number }> | null;
  /** Delay before the notification appears and any email is sent. */
  delayMinutes?: number;
  /** Batch email: hold it for this window so grouped notifications arrive as one message. */
  digestMinutes?: number | null;
}>;

export type StreamVersionRecord = Readonly<{ type: string; name: string; description: string; version: number; state: "draft" | "active" | "superseded" | "archived"; definition: StreamDefinition }>;

export const streamTypePattern = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u;
const variablePattern = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/gu;

export const defaultStreamDefinition: StreamDefinition = {
  inputs: [{ name: "message", type: "string", required: true }],
  recipients: ["user"],
  routes: { in_app: { default: true }, email: { default: false } },
  strategy: "parallel",
  policy: "user",
  templates: { title: "{{message}}", body: "{{message}}" },
  grouping: null,
  dedupe: null,
  delayMinutes: 0,
  digestMinutes: null,
};

export function templateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(variablePattern)].map((match) => match[1]!))];
}

/** Problems with a draft; empty means it can be published. */
export function streamDefinitionProblems(definition: StreamDefinition): string[] {
  const problems: string[] = [];
  const names = definition.inputs.map((input) => input.name);
  if (new Set(names).size !== names.length) problems.push("Input names must be unique");
  for (const input of definition.inputs) if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/u.test(input.name)) problems.push(`Input ${input.name || "(unnamed)"} must be a simple identifier`);
  if (!definition.recipients.length) problems.push("Allow at least one recipient kind");
  const routes = Object.keys(definition.routes) as NotificationChannel[];
  if (!routes.length) problems.push("Enable at least one delivery route");
  if (definition.strategy === "fallback" && !(definition.routes.in_app && definition.routes.email)) problems.push("Fallback delivery needs both the inbox and email routes");
  if (!definition.templates.title.trim()) problems.push("A title template is required");
  if (!definition.templates.body.trim()) problems.push("A body template is required");
  const declared = new Set(names);
  for (const [field, template] of Object.entries(definition.templates)) {
    for (const variable of templateVariables(template ?? "")) if (!declared.has(variable)) problems.push(`The ${field} template uses {{${variable}}}, which is not a declared input`);
  }
  for (const [field, rule] of [["grouping", definition.grouping], ["dedupe", definition.dedupe]] as const) {
    if (!rule) continue;
    if (!rule.windowMinutes || rule.windowMinutes < 1 || rule.windowMinutes > 10_080) problems.push(`The ${field} window must be between 1 minute and 7 days`);
    for (const variable of templateVariables(rule.key)) if (!declared.has(variable)) problems.push(`The ${field} key uses {{${variable}}}, which is not a declared input`);
  }
  if ((definition.delayMinutes ?? 0) < 0 || (definition.delayMinutes ?? 0) > 10_080) problems.push("The delay must be between 0 minutes and 7 days");
  if (definition.digestMinutes && !definition.grouping) problems.push("A digest needs a grouping key so notifications can be batched");
  if (definition.digestMinutes && !definition.routes.email) problems.push("A digest batches email; enable the email route");
  const link = definition.templates.link?.trim();
  if (link && !link.startsWith("/") && !link.startsWith("https://")) problems.push("Links must be application paths (/…) or https:// URLs");
  return problems;
}

/** Validates send-time data against the declared inputs. */
export function streamDataProblems(definition: StreamDefinition, data: EventPayload): string[] {
  const problems: string[] = [];
  for (const input of definition.inputs) {
    const value = data[input.name];
    if (value === undefined || value === null || value === "") { if (input.required) problems.push(`${input.name} is required`); continue; }
    const ok = input.type === "number" ? typeof value === "number" && Number.isFinite(value)
      : input.type === "boolean" ? typeof value === "boolean"
        : input.type === "url" ? typeof value === "string" && (value.startsWith("/") || /^https:\/\//u.test(value))
          : typeof value === "string";
    if (!ok) problems.push(`${input.name} must be a ${input.type}`);
  }
  const known = new Set(definition.inputs.map((input) => input.name));
  for (const key of Object.keys(data)) if (!known.has(key)) problems.push(`${key} is not an input of this stream`);
  return problems;
}

/** Substitutes declared variables; values are plain text, never markup. */
export function renderTemplate(template: string, data: EventPayload): string {
  return template.replace(variablePattern, (_match, name: string) => {
    const value = data[name];
    return value === undefined || value === null ? "" : String(value);
  });
}

/** A stream version as a notification definition the service can raise. */
export function streamToDefinition(stream: StreamVersionRecord): NotificationDefinition & { type: string } {
  const definition = stream.definition;
  const channels = definition.routes;
  const mandatory = definition.policy === "mandatory" ? Object.keys(channels) as NotificationChannel[] : undefined;
  return {
    type: stream.type, name: stream.name, description: stream.description, channels,
    ...(mandatory ? { mandatory } : {}),
    userConfigurable: definition.policy === "user",
    recipientKinds: definition.recipients,
    strategy: definition.strategy,
    streamVersion: stream.version,
    delayMinutes: definition.delayMinutes ?? 0,
    ...(definition.digestMinutes ? { emailDelayMinutes: definition.digestMinutes } : {}),
    validate: (payload) => streamDataProblems(definition, payload),
    ...(definition.grouping ? { group: { key: (payload: EventPayload) => renderTemplate(definition.grouping!.key, payload), windowMinutes: definition.grouping.windowMinutes } } : {}),
    ...(definition.dedupe ? { dedupe: { key: (payload: EventPayload) => renderTemplate(definition.dedupe!.key, payload), windowMinutes: definition.dedupe.windowMinutes } } : {}),
    render: (payload, count) => {
      const title = renderTemplate(definition.templates.title, payload);
      const link = definition.templates.link ? renderTemplate(definition.templates.link, payload) : undefined;
      return { title: count > 1 ? `${title} (${count})` : title, body: renderTemplate(definition.templates.body, payload), ...(link ? { link } : {}) };
    },
    operatorActions: { retry: true, cancel: definition.policy !== "mandatory" },
  };
}

/**
 * Code definitions plus active stream versions. A stream never overrides a
 * code-defined type; archived streams are reported so sends can fail visibly.
 */
export function composeNotificationCatalog(code: NotificationCatalog, active: readonly StreamVersionRecord[], archived: readonly string[] = []): NotificationCatalog & { archived: ReadonlySet<string> } {
  const streams = active.filter((stream) => !code.get(stream.type)).map(streamToDefinition);
  const all = [...code.list(), ...streams];
  return {
    get: (type) => all.find((entry) => entry.type === type),
    list: () => [...all],
    triggeredBy: (event) => code.triggeredBy(event),
    archived: new Set(archived),
  };
}
