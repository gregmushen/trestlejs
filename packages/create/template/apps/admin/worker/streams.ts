import type { ApplicationEnvironment } from "@__TRESTLE_PROJECT_NAME__/authz";
import { PostgresNotificationRepository } from "@__TRESTLE_PROJECT_NAME__/data";
import {
  composeNotificationCatalog,
  defaultStreamDefinition,
  NotificationError,
  NotificationService,
  notifications,
  renderTemplate,
  streamDataProblems,
  streamDefinitionProblems,
  streamTypePattern,
  type StreamDefinition,
} from "@__TRESTLE_PROJECT_NAME__/domain";
import { PlatformRequestError, type PlatformAudit, type PostgresPlatformRepository } from "@__TRESTLE_PROJECT_NAME__/platform";
import type { Context, Hono } from "hono";
import { z } from "zod";

/**
 * Communications -> Notifications -> Streams (docs/ADMIN_REQUIRED_CHANGES.md §8.1).
 * A stream is the data-defined contract behind `ctx.notifications.send`. The
 * type key is immutable, published versions are immutable, and editing
 * always happens on the single draft. Publishing supersedes the previous
 * active version; archiving keeps every version so history stays readable
 * and later sends fail visibly. Code-defined types are listed read-only.
 */

type Bindings = { DATABASE_URL: string; DATABASE_DRIVER?: "neon-http" | "postgres-js"; APP_ENV?: ApplicationEnvironment };
type Authority = { operator: { id: string }; require(permission: string): void; requireSensitive(permission: string, reason: unknown): string };
type Environment = { Bindings: Bindings; Variables: { authority: Authority; correlationId: string } };
type AuditInput = Omit<PlatformAudit, "actorId" | "environment" | "correlationId" | "now">;
type Dependencies = { repository: (environment: Bindings) => PostgresPlatformRepository; audit: (context: Context<Environment>, entry: AuditInput) => PlatformAudit; now: () => Date };

const reason = z.string().trim().min(1).max(500);
const window = z.object({ key: z.string().trim().min(1).max(200), windowMinutes: z.number().int() }).nullable().optional();
const definitionSchema: z.ZodType<StreamDefinition> = z.object({
  inputs: z.array(z.object({ name: z.string().trim().max(40), type: z.enum(["string", "number", "boolean", "url"]), required: z.boolean() }).strict()).max(30),
  recipients: z.array(z.enum(["user", "organization_role"])).max(2),
  routes: z.object({ in_app: z.object({ default: z.boolean() }).strict().optional(), email: z.object({ default: z.boolean() }).strict().optional() }).strict(),
  strategy: z.enum(["parallel", "fallback"]),
  policy: z.enum(["user", "organization", "mandatory"]),
  templates: z.object({ title: z.string().max(200), body: z.string().max(2_000), link: z.string().max(500).optional() }).strict(),
  grouping: window, dedupe: window,
  delayMinutes: z.number().int().optional(),
  digestMinutes: z.number().int().min(1).max(10_080).nullable().optional(),
}).strict() as never;
const payload = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

async function json<T extends z.ZodType>(context: Context<Environment>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => undefined));
  if (!parsed.success) throw new PlatformRequestError(422, "invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  return parsed.data;
}

const versionRef = (type: string, version: number) => `${type}@${version}`;

export function registerNotificationStreamRoutes(admin: Hono<Environment>, dependencies: Dependencies) {
  const repo = (context: Context<Environment>) => dependencies.repository(context.env);

  async function load(context: Context<Environment>, type: string) {
    const found = await repo(context).notificationStream(type);
    if (!found) throw new PlatformRequestError(404, "not_found", "Notification stream not found");
    const versions = found.versions.map((version) => ({ ...version, definition: version.definition as unknown as StreamDefinition }));
    return { stream: found.stream, versions, draft: versions.find((version) => version.state === "draft") ?? null, active: versions.find((version) => version.state === "active") ?? null };
  }

  const mutable = (loaded: Awaited<ReturnType<typeof load>>) => {
    if (loaded.stream.archivedAt) throw new PlatformRequestError(409, "archived", "This stream is archived; restore it to change it");
  };

  admin.get("/api/admin/notification-streams", async (context) => {
    context.get("authority").require("platform.notifications.read");
    const rows = await repo(context).notificationStreamRows();
    return context.json({
      streams: rows.map(({ definition, ...row }) => ({ ...row, routes: Object.keys((definition as StreamDefinition | null)?.routes ?? {}), policy: (definition as StreamDefinition | null)?.policy ?? "user" })),
      code: notifications.list().map((definition) => ({ type: definition.type, name: definition.name, description: definition.description, routes: Object.keys(definition.channels), mandatory: definition.mandatory ?? [] })),
    });
  });

  admin.get("/api/admin/notification-streams/:type", async (context) => {
    context.get("authority").require("platform.notifications.read");
    const loaded = await load(context, context.req.param("type"));
    const recent = await dependencies.repository(context.env).notifications({ type: loaded.stream.type });
    const audit = await dependencies.repository(context.env).auditFor("notification_stream", [loaded.stream.type, ...loaded.versions.map((version) => versionRef(loaded.stream.type, version.version))]);
    return context.json({ ...loaded, problems: loaded.draft ? streamDefinitionProblems(loaded.draft.definition) : [], recent: recent.slice(0, 25), audit });
  });

  admin.post("/api/admin/notification-streams", async (context) => {
    const input = await json(context, z.object({ type: z.string().trim().min(3).max(100), name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).default(""), reason }).strict());
    const authority = context.get("authority");
    const why = authority.requireSensitive("platform.notification_streams.manage", input.reason);
    if (!streamTypePattern.test(input.type)) throw new PlatformRequestError(422, "invalid", "Type keys are lowercase dotted identifiers such as billing.invoice_ready");
    if (notifications.get(input.type)) throw new PlatformRequestError(409, "conflict", `${input.type} is defined in code`);
    if (await repo(context).notificationStream(input.type)) throw new PlatformRequestError(409, "conflict", `${input.type} already exists; type keys are never reused`);
    const by = authority.operator.id;
    await repo(context).mutate(repo(context).insertNotificationStream(input, defaultStreamDefinition, by), dependencies.audit(context, { name: "communications.notification_stream.created", organizationId: null, targetType: "notification_stream", targetId: input.type, reason: why, summary: { name: input.name } }));
    return context.json(await load(context, input.type), 201);
  });

  admin.patch("/api/admin/notification-streams/:type", async (context) => {
    const input = await json(context, z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(500), reason }).strict());
    const why = context.get("authority").requireSensitive("platform.notification_streams.manage", input.reason);
    const loaded = await load(context, context.req.param("type"));
    await repo(context).mutate(repo(context).renameNotificationStream(loaded.stream.type, input),
      dependencies.audit(context, { name: "communications.notification_stream.renamed", organizationId: null, targetType: "notification_stream", targetId: loaded.stream.type, reason: why, summary: { from: loaded.stream.name, to: input.name } }));
    return context.body(null, 204);
  });

  // Draft edits are frequent and reversible until publish, so they need the permission but no reason.
  admin.put("/api/admin/notification-streams/:type/draft", async (context) => {
    context.get("authority").require("platform.notification_streams.manage");
    const input = await json(context, z.object({ definition: definitionSchema }).strict());
    const loaded = await load(context, context.req.param("type"));
    mutable(loaded);
    if (!loaded.draft) throw new PlatformRequestError(409, "no_draft", "Create a draft before editing");
    await repo(context).mutate(repo(context).updateNotificationStreamDraft(loaded.stream.type, loaded.draft.version, input.definition),
      dependencies.audit(context, { name: "communications.notification_stream.draft_revised", organizationId: null, targetType: "notification_stream", targetId: versionRef(loaded.stream.type, loaded.draft.version), reason: "draft edit", summary: {} }));
    return context.json({ problems: streamDefinitionProblems(input.definition) });
  });

  admin.post("/api/admin/notification-streams/:type/drafts", async (context) => {
    const input = await json(context, z.object({ reason }).strict());
    const why = context.get("authority").requireSensitive("platform.notification_streams.manage", input.reason);
    const loaded = await load(context, context.req.param("type"));
    mutable(loaded);
    if (loaded.draft) throw new PlatformRequestError(409, "conflict", `Version ${loaded.draft.version} is already a draft`);
    const source = loaded.active ?? loaded.versions[0];
    const version = (loaded.versions[0]?.version ?? 0) + 1;
    await repo(context).mutate(repo(context).insertNotificationStreamDraft(loaded.stream.type, version, source?.definition ?? defaultStreamDefinition, context.get("authority").operator.id),
      dependencies.audit(context, { name: "communications.notification_stream.drafted", organizationId: null, targetType: "notification_stream", targetId: versionRef(loaded.stream.type, version), reason: why, summary: { from: source?.version ?? null } }));
    return context.json({ version }, 201);
  });

  admin.delete("/api/admin/notification-streams/:type/draft", async (context) => {
    const input = await json(context, z.object({ reason }).strict());
    const why = context.get("authority").requireSensitive("platform.notification_streams.manage", input.reason);
    const loaded = await load(context, context.req.param("type"));
    if (!loaded.draft) throw new PlatformRequestError(409, "no_draft", "There is no draft to discard");
    if (!loaded.active && loaded.versions.length === 1) throw new PlatformRequestError(409, "conflict", "A never-published stream keeps its first draft; archive the stream instead");
    await repo(context).mutate(repo(context).deleteNotificationStreamDraft(loaded.stream.type, loaded.draft.version),
      dependencies.audit(context, { name: "communications.notification_stream.draft_discarded", organizationId: null, targetType: "notification_stream", targetId: versionRef(loaded.stream.type, loaded.draft.version), reason: why, summary: {} }));
    return context.body(null, 204);
  });

  admin.post("/api/admin/notification-streams/:type/publish", async (context) => {
    const input = await json(context, z.object({ reason }).strict());
    const authority = context.get("authority");
    const why = authority.requireSensitive("platform.notification_streams.manage", input.reason);
    const loaded = await load(context, context.req.param("type"));
    mutable(loaded);
    if (!loaded.draft) throw new PlatformRequestError(409, "no_draft", "There is no draft to publish");
    const problems = streamDefinitionProblems(loaded.draft.definition);
    if (problems.length) throw new PlatformRequestError(422, "invalid", problems.join("; "));
    await repo(context).mutate(repo(context).publishNotificationStream(loaded.stream.type, loaded.draft.version, authority.operator.id), dependencies.audit(context, { name: "communications.notification_stream.published", organizationId: null, targetType: "notification_stream", targetId: versionRef(loaded.stream.type, loaded.draft.version), reason: why, summary: { supersedes: loaded.active?.version ?? null } }));
    return context.body(null, 204);
  });

  for (const [action, archived] of [["archive", true], ["restore", false]] as const) {
    admin.post(`/api/admin/notification-streams/:type/${action}`, async (context) => {
      const input = await json(context, z.object({ reason }).strict());
      const authority = context.get("authority");
      const why = authority.requireSensitive("platform.notification_streams.manage", input.reason);
      const loaded = await load(context, context.req.param("type"));
      if (Boolean(loaded.stream.archivedAt) === archived) throw new PlatformRequestError(409, "conflict", archived ? "The stream is already archived" : "The stream is not archived");
      await repo(context).mutate(repo(context).setNotificationStreamArchived(loaded.stream.type, archived, authority.operator.id),
      dependencies.audit(context, { name: `communications.notification_stream.${archived ? "archived" : "restored"}`, organizationId: null, targetType: "notification_stream", targetId: loaded.stream.type, reason: why, summary: { activeVersion: loaded.active?.version ?? null } }));
      return context.body(null, 204);
    });
  }

  /** Renders a version (or an unsaved definition) with sample data; nothing is stored or sent. */
  admin.post("/api/admin/notification-streams/:type/preview", async (context) => {
    context.get("authority").require("platform.notifications.read");
    const input = await json(context, z.object({ definition: definitionSchema.optional(), version: z.number().int().optional(), data: payload }).strict());
    const loaded = await load(context, context.req.param("type"));
    const definition = input.definition ?? loaded.versions.find((version) => version.version === input.version)?.definition ?? loaded.draft?.definition ?? loaded.active?.definition;
    if (!definition) throw new PlatformRequestError(404, "not_found", "No version to preview");
    const link = definition.templates.link ? renderTemplate(definition.templates.link, input.data) : null;
    return context.json({ title: renderTemplate(definition.templates.title, input.data), body: renderTemplate(definition.templates.body, input.data), link, problems: [...streamDefinitionProblems(definition), ...streamDataProblems(definition, input.data)] });
  });

  /** A marked test to one member: titled "[Test]", never grouped or deduplicated, recorded like any send. */
  admin.post("/api/admin/notification-streams/:type/test", async (context) => {
    const input = await json(context, z.object({ organizationId: z.string().min(1), userId: z.string().min(1), version: z.number().int().optional(), data: payload, reason }).strict());
    const authority = context.get("authority");
    const why = authority.requireSensitive("platform.notification_streams.manage", input.reason);
    const loaded = await load(context, context.req.param("type"));
    const target = loaded.versions.find((version) => version.version === input.version) ?? loaded.draft ?? loaded.active;
    if (!target) throw new PlatformRequestError(404, "not_found", "No version to test");
    const catalog = composeNotificationCatalog(notifications, [{ ...loaded.stream, version: target.version, state: target.state, definition: target.definition }]);
    const service = new NotificationService(new PostgresNotificationRepository(context.env.DATABASE_URL, context.env.DATABASE_DRIVER, input.organizationId), catalog);
    try {
      const result = await service.send({
        organizationId: input.organizationId, actor: { type: "platform_operator", id: authority.operator.id }, correlationId: context.get("correlationId"), environment: context.env.APP_ENV ?? "local", now: dependencies.now(), reason: why,
      }, { type: loaded.stream.type, recipient: { userId: input.userId }, data: input.data }, { test: true });
      return context.json({ ...result, version: target.version }, 202);
    } catch (error) {
      if (error instanceof NotificationError) throw new PlatformRequestError(error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 422, error.code, error.message);
      throw error;
    }
  });
}
