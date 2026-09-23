import { parse } from "yaml";

export type CapabilityId = "email" | "payments" | "admin" | "queues" | "workflows" | "r2" | "durableObjects" | "plans" | "serviceAccounts" | "apiKeys" | "webhooks" | "notifications" | "supportSessions" | "passkeys" | "twoFactor" | "sso" | "directory" | "metering";
export type CapabilityState = "disabled" | "declared" | "configured" | "deployed" | "verified";
export type RuntimeEnvironment = "local" | "preview" | "staging" | "production";

export type DeclaredCapabilities = Readonly<{
  email: "disabled" | "local" | "resend";
  payments: "disabled" | "local" | "stripe" | "lago";
  admin: boolean;
  queues: boolean;
  workflows: boolean;
  r2: boolean;
  durableObjects: boolean;
  plans: boolean;
  usage: boolean;
  serviceAccounts: boolean;
  apiKeys: boolean;
  webhooks: boolean;
  notifications: boolean;
  supportSessions: boolean;
  passkeys: boolean;
  twoFactor: boolean;
  sso: "disabled" | "better-auth" | "workos";
  directory: "disabled" | "better-auth-scim" | "workos";
  metering: "native" | "openmeter" | "lago";
  webhookDispatch: "native" | "svix";
}>;

/** Sanitized status: presence and health only, never values. */
export type CapabilityStatus = Readonly<{
  id: CapabilityId;
  label: string;
  state: CapabilityState;
  healthy: boolean;
  /** Provider mode such as "Resend" or "Stripe test mode"; never a credential. */
  mode?: string;
  message?: string;
  repair?: string;
}>;

export const capabilityLabels: Readonly<Record<CapabilityId, string>> = {
  email: "Email delivery",
  payments: "Payments",
  admin: "Platform admin",
  queues: "Queues and DLQ",
  workflows: "Workflows",
  r2: "Artifact storage",
  durableObjects: "Durable Objects",
  plans: "Plans and entitlements",
  serviceAccounts: "Service accounts",
  apiKeys: "API keys",
  webhooks: "Webhooks",
  notifications: "Notifications",
  supportSessions: "Support sessions",
  passkeys: "Passkeys",
  twoFactor: "Two-factor authentication",
  sso: "Enterprise SSO",
  directory: "Directory provisioning",
  metering: "Usage metering",
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Reads declared capabilities from the project manifest (.trestle/project.yaml). Unknown shapes fail closed. */
export function declaredCapabilities(manifestText: string): DeclaredCapabilities {
  let document: Record<string, unknown> = {};
  try { document = record(parse(manifestText)); } catch { document = {}; }
  const capabilities = record(document.capabilities);
  const integrations = record(document.integrations);
  const access = record(document.access);
  const commercial = record(document.commercial);
  const communications = record(document.communications);
  const authentication = record(document.authentication);
  const identity = record(document.identity);
  const flag = (value: unknown) => value === true;
  const email = integrations.email === "local" || integrations.email === "resend" ? integrations.email : "disabled";
  const payments = integrations.payments === "local" || integrations.payments === "stripe" || integrations.payments === "lago" ? integrations.payments : "disabled";
  return {
    email, payments,
    admin: flag(capabilities.admin), queues: flag(capabilities.queues), workflows: flag(capabilities.workflows), r2: flag(capabilities.r2), durableObjects: flag(capabilities.durableObjects),
    plans: flag(commercial.plans), usage: flag(commercial.usage), serviceAccounts: flag(access.serviceAccounts), apiKeys: flag(access.apiKeys) && flag(access.serviceAccounts),
    webhooks: flag(communications.webhooks), notifications: flag(communications.notifications), supportSessions: flag(access.supportSessions) && flag(capabilities.admin),
    // Omitted authentication means both mechanisms are on, as generated.
    passkeys: authentication.passkeys !== "disabled",
    twoFactor: authentication.twoFactor !== "disabled",
    sso: identity.sso === "better-auth" || identity.sso === "workos" ? identity.sso : "disabled",
    directory: (identity.directory === "better-auth-scim" && identity.sso === "better-auth") || (identity.directory === "workos" && identity.sso === "workos") ? identity.directory : "disabled",
    metering: flag(commercial.usage) && (integrations.metering === "openmeter" || (integrations.metering === "lago" && payments === "lago")) ? integrations.metering : "native",
    webhookDispatch: flag(communications.webhooks) && integrations.webhooks === "svix" ? "svix" : "native",
  };
}

const present = (value: unknown): boolean => typeof value === "string" ? value.trim() !== "" && value !== "CHANGE_ME" : value !== undefined && value !== null;

/**
 * Computes the runtime capability projection from the running Worker's own
 * bindings. It inspects presence only and never copies a value.
 */
export function computeCapabilityStatus(declared: DeclaredCapabilities, environment: RuntimeEnvironment, env: Readonly<Record<string, unknown>>): CapabilityStatus[] {
  const repair = `pnpm exec trestle setup --env ${environment}`;
  const running: CapabilityState = environment === "local" ? "configured" : "deployed";
  const status = (id: CapabilityId, isDeclared: boolean, missing: string[], unhealthy?: string): CapabilityStatus => {
    if (!isDeclared) return { id, label: capabilityLabels[id], state: "disabled", healthy: true };
    if (missing.length) return { id, label: capabilityLabels[id], state: "declared", healthy: false, message: `${capabilityLabels[id]} is not configured for ${environment}: missing ${missing.join(", ")}.`, repair };
    if (unhealthy) return { id, label: capabilityLabels[id], state: running, healthy: false, message: unhealthy, repair };
    return { id, label: capabilityLabels[id], state: running, healthy: true };
  };
  const missing = (...names: string[]) => names.filter((name) => !present(env[name]));

  const email = declared.email === "resend"
    ? status("email", true, environment === "local" ? [] : missing("RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "EMAIL_FROM"))
    : status("email", declared.email === "local", [], environment === "local" ? undefined : `Local email capture cannot deliver email in ${environment}.`);
  const stripeMode = String(env.STRIPE_MODE ?? "local");
  const payments = declared.payments === "stripe"
    ? status("payments", true, environment === "local" && stripeMode === "local" ? [] : missing("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"), environment === "production" && stripeMode !== "live" ? "Production payments are not in Stripe live mode." : undefined)
    : declared.payments === "lago"
      ? status("payments", true, environment === "local" ? [] : missing("LAGO_API_KEY"))
      : status("payments", declared.payments === "local", [], environment === "local" ? undefined : `Local billing cannot collect payment in ${environment}.`);
  const emailMode = declared.email === "resend" && environment !== "local" ? "Resend" : declared.email === "disabled" ? undefined : "local capture";
  const paymentsMode = declared.payments === "stripe" ? (stripeMode === "local" ? "local billing" : `Stripe ${stripeMode} mode`) : declared.payments === "lago" ? "Lago" : declared.payments === "local" ? "local billing" : undefined;
  return [
    emailMode ? { ...email, mode: emailMode } : email,
    paymentsMode ? { ...payments, mode: paymentsMode } : payments,
    status("admin", declared.admin, []),
    status("queues", declared.queues, missing("QUEUE")),
    status("workflows", declared.workflows, missing("WORKFLOW")),
    status("r2", declared.r2, environment === "local" ? [] : missing("ARTIFACTS")),
    status("durableObjects", declared.durableObjects, missing("COORDINATOR")),
    status("plans", declared.plans, []),
    status("serviceAccounts", declared.serviceAccounts, []),
    status("apiKeys", declared.apiKeys, []),
    // Signing secrets need their own encryption key outside local and preview.
    { ...status("webhooks", declared.webhooks, [...(environment === "local" || environment === "preview" ? [] : missing("WEBHOOK_SECRET_KEY")), ...(declared.webhookDispatch === "svix" ? missing("SVIX_API_KEY") : [])]),
      ...(declared.webhooks ? { mode: declared.webhookDispatch === "svix" ? "Svix dispatch" : "native delivery" } : {}) },
    status("notifications", declared.notifications, [], declared.notifications && declared.email === "disabled" ? "Notifications are declared but email is disabled; only the in-app channel will deliver." : undefined),
    status("supportSessions", declared.supportSessions, []),
    status("passkeys", declared.passkeys, []),
    status("twoFactor", declared.twoFactor, []),
    { ...status("sso", declared.sso !== "disabled", declared.sso === "workos" && environment !== "local" ? missing("WORKOS_API_KEY", "WORKOS_CLIENT_ID") : [],
      declared.sso === "better-auth" && environment !== "local" && env.DATABASE_DRIVER === "neon-http" ? "Better Auth SSO needs interactive transactions; neon-http cannot provide them." : undefined),
      ...(declared.sso !== "disabled" ? { mode: declared.sso === "workos" ? "WorkOS" : "Better Auth (OIDC and SAML)" } : {}) },
    { ...status("directory", declared.directory !== "disabled", declared.directory === "workos" && environment !== "local" ? missing("WORKOS_WEBHOOK_SECRET") : [],
      declared.directory === "better-auth-scim" && env.DATABASE_DRIVER === "neon-http" ? "SCIM provisioning needs interactive transactions; neon-http cannot provide them." : undefined),
      ...(declared.directory !== "disabled" ? { mode: declared.directory === "workos" ? "WorkOS Directory Sync" : "Better Auth SCIM" } : {}) },
    { ...status("metering", declared.usage, declared.metering === "openmeter" && environment !== "local" ? missing("OPENMETER_API_KEY") : declared.metering === "lago" && environment !== "local" ? missing("LAGO_API_KEY") : []),
      mode: declared.metering === "openmeter" ? "OpenMeter" : declared.metering === "lago" ? "Lago" : "native projection" },
  ];
}

export function capabilityAvailable(statuses: readonly CapabilityStatus[], id: CapabilityId): boolean {
  const status = statuses.find((candidate) => candidate.id === id);
  return Boolean(status && status.state !== "disabled" && status.state !== "declared" && status.healthy);
}
