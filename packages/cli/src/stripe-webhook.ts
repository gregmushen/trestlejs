import { createHash } from "node:crypto";

import { stripeServerKeyMatchesMode } from "./stripe-deployment.js";

export const STRIPE_BILLING_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

type RemoteEnvironment = "preview" | "staging" | "production";
type StripeEndpoint = { id: string; url: string; status: "enabled" | "disabled"; livemode: boolean; enabled_events: string[]; secret?: string };
type StripeEndpointList = { data: StripeEndpoint[]; has_more: boolean };

export type StripeWebhookPlan = {
  classification: "create" | "rotate" | "needs_rotation" | "blocked";
  url: string;
  environment: RemoteEnvironment;
  enabledEndpointIds: string[];
  createdEndpointId?: string;
  disabledEndpointId?: string;
  reason?: string;
};

export type ConfigureStripeWebhookInput = {
  environment: RemoteEnvironment;
  url: string;
  apiKey: string;
  apply: boolean;
  operationId?: string;
  replaceEndpointId?: string;
  resume?: boolean;
  persistSecret?: (secret: string) => Promise<void>;
  request?: typeof fetch;
};

function webhookUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Stripe webhook URL must be an absolute HTTPS URL"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || url.pathname !== "/webhooks/stripe" || url.port) {
    throw new Error("Stripe webhook URL must be a bare HTTPS origin followed by /webhooks/stripe");
  }
  return url.toString();
}

async function stripeRequest<T>(apiKey: string, pathname: string, request: typeof fetch, init: RequestInit = {}): Promise<T> {
  const response = await request(`https://api.stripe.com${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...init.headers },
  });
  if (!response.ok) throw new Error(`Stripe webhook API returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function listEndpoints(apiKey: string, request: typeof fetch): Promise<StripeEndpoint[]> {
  const all: StripeEndpoint[] = [];
  let after: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const query = new URLSearchParams({ limit: "100", ...(after ? { starting_after: after } : {}) });
    const result = await stripeRequest<StripeEndpointList>(apiKey, `/v1/webhook_endpoints?${query}`, request);
    if (!Array.isArray(result.data) || typeof result.has_more !== "boolean") throw new Error("Stripe webhook list response is invalid");
    all.push(...result.data);
    if (!result.has_more) return all;
    after = result.data.at(-1)?.id;
    if (!after) throw new Error("Stripe webhook list pagination is invalid");
  }
  throw new Error("Stripe webhook list exceeds the supported review bound");
}

function validEndpoint(value: StripeEndpoint, url: string, live: boolean): boolean {
  return /^we_[A-Za-z0-9]+$/u.test(value.id) && value.url === url && value.livemode === live
    && value.status === "enabled" && STRIPE_BILLING_EVENTS.every((event) => value.enabled_events.includes(event));
}

/** Stripe only returns the signing secret when an endpoint is created. A
 * configured whsec_ value alone cannot establish that it matches the remote
 * endpoint, so existing destinations require an explicit reviewed rotation. */
export async function configureStripeWebhook(input: ConfigureStripeWebhookInput): Promise<StripeWebhookPlan> {
  const url = webhookUrl(input.url);
  if (!stripeServerKeyMatchesMode(input.apiKey, input.environment)) throw new Error("Stripe management key does not match the target environment mode");
  if (input.replaceEndpointId && !/^we_[A-Za-z0-9]+$/u.test(input.replaceEndpointId)) throw new Error("replacement endpoint ID is invalid");
  if (input.apply && (!input.operationId || !/^[A-Za-z0-9_-]{8,64}$/u.test(input.operationId))) {
    throw new Error("--apply requires a stable --operation-id of 8–64 safe characters for retries");
  }
  if (input.resume && !input.apply) throw new Error("--resume is only valid with --apply");
  if (input.apply && !input.persistSecret) throw new Error("encrypted secret persistence is required before creating a webhook endpoint");
  const request = input.request ?? fetch;
  const endpoints = await listEndpoints(input.apiKey, request);
  const live = input.environment === "production";
  const matching = endpoints.filter((endpoint) => endpoint.url === url && endpoint.livemode === live);
  const enabled = matching.filter((endpoint) => endpoint.status === "enabled");
  const ids = enabled.map((endpoint) => endpoint.id);
  const old = input.replaceEndpointId ? matching.find((endpoint) => endpoint.id === input.replaceEndpointId) : undefined;
  if (input.replaceEndpointId && (!old || (old.status !== "enabled" && !(input.resume && old.status === "disabled")))) {
    throw new Error("named old Stripe webhook endpoint is not enabled at the exact target URL (or already disabled during this resumed operation)");
  }
  const classification = input.replaceEndpointId ? (enabled.length === 1 || (input.resume && enabled.length === 2) ? "rotate" : "blocked")
    : enabled.length === 0 || (input.resume && enabled.length === 1) ? "create" : enabled.length === 1 ? "needs_rotation" : "blocked";
  const plan: StripeWebhookPlan = { classification, url, environment: input.environment, enabledEndpointIds: ids,
    ...(classification === "needs_rotation" ? { reason: "remote signing secret cannot be retrieved; name this endpoint with --replace-endpoint-id to rotate it" } : {}),
    ...(classification === "blocked" ? { reason: "multiple enabled endpoints or an ambiguous replacement; review Stripe endpoints before applying" } : {}),
  };
  if (!input.apply) return plan;
  if (classification === "needs_rotation" || classification === "blocked") throw new Error(plan.reason);
  const operationKey = `trestlejs:webhook:${input.environment}:${createHash("sha256").update(url).digest("hex").slice(0, 16)}:${input.operationId}`;
  const body = new URLSearchParams({ url, description: `TrestleJS ${input.environment} billing webhook` });
  for (const event of STRIPE_BILLING_EVENTS) body.append("enabled_events[]", event);
  const created = await stripeRequest<StripeEndpoint>(input.apiKey, "/v1/webhook_endpoints", request, {
    method: "POST", body, headers: { "idempotency-key": operationKey },
  });
  if (!validEndpoint(created, url, live) || !created.secret || !/^whsec_[A-Za-z0-9_]+$/u.test(created.secret)) {
    throw new Error("Stripe did not return a matching enabled endpoint and signing secret");
  }
  const otherEnabled = enabled.filter((endpoint) => endpoint.id !== created.id);
  if (otherEnabled.length !== (old?.status === "enabled" && old.id !== created.id ? 1 : 0)
    || otherEnabled.some((endpoint) => endpoint.id !== old?.id)) {
    throw new Error(`Stripe endpoint ${created.id} was created but remote endpoint state changed; review before storing its secret`);
  }
  try { await input.persistSecret!(created.secret); }
  catch { throw new Error(`Stripe endpoint ${created.id} exists, but encrypted secret storage failed; rerun with the same --operation-id and --resume`); }
  if (old && old.id !== created.id) {
    try {
      const disabled = await stripeRequest<StripeEndpoint>(input.apiKey, `/v1/webhook_endpoints/${old.id}`, request, {
        method: "POST", body: new URLSearchParams({ disabled: "true" }), headers: { "idempotency-key": `${operationKey}:disable` },
      });
      if (disabled.id !== old.id || disabled.status !== "disabled") throw new Error("unexpected endpoint status");
    } catch {
      throw new Error(`Stripe endpoint ${created.id} is configured, but old endpoint ${old.id} could not be disabled; rerun with the same --operation-id and --resume`);
    }
  }
  return { ...plan, createdEndpointId: created.id, ...(old && old.id !== created.id ? { disabledEndpointId: old.id } : {}) };
}
