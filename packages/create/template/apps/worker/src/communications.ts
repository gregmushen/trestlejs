import { createApplicationEmail, type AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { loadNotificationStreams, PostgresNotificationRepository, PostgresWebhookRepository } from "@__TRESTLE_PROJECT_NAME__/data";
import { applicationConnectionString, createSqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";
import { composeNotificationCatalog, NativeWebhookTransport, notifications, publicDestinationGuard, webhookKeyMaterial as sharedKeyMaterial, SvixWebhookTransport, NotificationService, secretCipher, WebhookDispatcher, WebhookService, type Fetcher, type NotificationEmailSender, type OperationContext, type WebhookTransport } from "@__TRESTLE_PROJECT_NAME__/domain";
import { notificationTemplate } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { declaredCapabilities } from "@__TRESTLE_PROJECT_NAME__/platform";

import manifestText from "../../../.trestle/project.yaml";

const declared = declaredCapabilities(manifestText);

/** Whether each addition is declared in .trestle/project.yaml; undeclared features answer 404. */
export const communicationsEnabled = { webhooks: declared.webhooks, notifications: declared.notifications } as const;

/** Signing secrets need a dedicated key outside local and preview. */
export const webhookKeyMaterial = (environment: AuthEnvironment) => sharedKeyMaterial(environment);

/** Replaceable for tests. */
export const communicationDependencies = {
  webhookRepository: (environment: AuthEnvironment, organizationId: string) => new PostgresWebhookRepository(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId),
  notificationRepository: (environment: AuthEnvironment, organizationId: string) => new PostgresNotificationRepository(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId),
  fetcher: ((url, init) => fetch(url, init)) as Fetcher,
  notificationStreams: async (environment: AuthEnvironment) => await loadNotificationStreams(createSqlRunner(applicationConnectionString(environment.DATABASE_URL), environment.DATABASE_DRIVER)),
  /** Native Worker delivery, or Svix when declared. A declared Svix without a key fails closed and retries. */
  webhookTransport: (environment: AuthEnvironment): WebhookTransport => {
    if (declared.webhookDispatch !== "svix") return new NativeWebhookTransport(communicationDependencies.fetcher);
    if (!environment.SVIX_API_KEY) return { kind: "svix", send: async () => ({ responseCode: null, error: new Error("SVIX_API_KEY is not configured; run trestle setup") }) };
    return new SvixWebhookTransport({ apiKey: environment.SVIX_API_KEY, ...(environment.SVIX_SERVER_URL ? { serverUrl: environment.SVIX_SERVER_URL } : {}) });
  },
  emailSender: (environment: AuthEnvironment): NotificationEmailSender => {
    const email = createApplicationEmail(environment);
    const origin = environment.WEB_ORIGIN ?? "http://localhost:42069";
    return async (message, options) => await email.send({ to: message.to, subject: message.title, template: notificationTemplate({ title: message.title, body: message.body, ...(message.link ? { url: new URL(message.link, origin).toString() } : {}) }) }, options);
  },
};

export async function webhookService(environment: AuthEnvironment, organizationId: string) {
  return new WebhookService(communicationDependencies.webhookRepository(environment, organizationId), await secretCipher(webhookKeyMaterial(environment)));
}

export async function webhookDispatcher(environment: AuthEnvironment, organizationId: string) {
  // Outside local, each attempt re-resolves the destination and refuses private or metadata addresses.
  const guard = (environment.APP_ENV ?? "local") === "local" ? undefined : publicDestinationGuard();
  return new WebhookDispatcher(communicationDependencies.webhookRepository(environment, organizationId), await secretCipher(webhookKeyMaterial(environment)), communicationDependencies.webhookTransport(environment), 10_000, guard);
}

/** Code-defined notifications plus the active published stream versions, loaded per use. */
export async function notificationService(environment: AuthEnvironment, organizationId: string) {
  const streams = await communicationDependencies.notificationStreams(environment);
  return new NotificationService(communicationDependencies.notificationRepository(environment, organizationId), composeNotificationCatalog(notifications, streams.active, streams.archived));
}

export function systemContext(environment: AuthEnvironment, organizationId: string, correlationId: string, now = new Date()): OperationContext {
  return { organizationId, actor: { type: "system", id: "system:outbox" }, correlationId, environment: environment.APP_ENV ?? "local", now };
}
