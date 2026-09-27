/** Delivery outcomes the generated Worker records and publishes to the outbox. */
export const RESEND_DELIVERY_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
] as const;

type RemoteEnvironment = "preview" | "staging" | "production";
type ResendWebhook = { id: string; endpoint: string; status: "enabled" | "disabled"; events: string[]; signing_secret?: string };
type ResendWebhookList = { data: ResendWebhook[]; has_more: boolean };

export type ResendWebhookPlan = {
  classification: "create" | "rotate" | "needs_rotation" | "blocked";
  url: string;
  environment: RemoteEnvironment;
  enabledWebhookIds: string[];
  createdWebhookId?: string;
  disabledWebhookId?: string;
  reason?: string;
};

export type ConfigureResendWebhookInput = {
  environment: RemoteEnvironment;
  url: string;
  apiKey: string;
  apply: boolean;
  replaceWebhookId?: string;
  resume?: boolean;
  persistSecret?: (secret: string) => Promise<void>;
  request?: typeof fetch;
};

export type ResendWebhookStatus = Readonly<{ url: string; found: boolean; enabled: boolean; eventsMatch: boolean; secretMatches: boolean }>;

const webhookId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function resendWebhookUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Resend webhook URL must be an absolute HTTPS URL"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || url.pathname !== "/api/webhooks/resend" || url.port) {
    throw new Error("Resend webhook URL must be a bare HTTPS origin followed by /api/webhooks/resend");
  }
  return url.toString();
}

async function resendRequest<T>(apiKey: string, pathname: string, request: typeof fetch, init: RequestInit = {}): Promise<T> {
  const response = await request(`https://api.resend.com${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!response.ok) throw new Error(`Resend webhook API returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function listWebhooks(apiKey: string, request: typeof fetch): Promise<ResendWebhook[]> {
  const all: ResendWebhook[] = [];
  let after: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const query = new URLSearchParams({ limit: "100", ...(after ? { after } : {}) });
    const result = await resendRequest<ResendWebhookList>(apiKey, `/webhooks?${query}`, request);
    if (!Array.isArray(result.data) || typeof result.has_more !== "boolean") throw new Error("Resend webhook list response is invalid");
    all.push(...result.data);
    if (!result.has_more) return all;
    after = result.data.at(-1)?.id;
    if (!after) throw new Error("Resend webhook list pagination is invalid");
  }
  throw new Error("Resend webhook list exceeds the supported review bound");
}

function subscribed(value: ResendWebhook): boolean {
  return Array.isArray(value.events) && RESEND_DELIVERY_EVENTS.every((event) => value.events.includes(event));
}

async function retrieveWebhook(apiKey: string, id: string, url: string, request: typeof fetch): Promise<ResendWebhook & { signing_secret: string }> {
  const found = await resendRequest<ResendWebhook>(apiKey, `/webhooks/${id}`, request);
  if (found.id !== id || found.endpoint !== url || found.status !== "enabled" || !subscribed(found)
    || !found.signing_secret || !/^whsec_[A-Za-z0-9+/=_]+$/u.test(found.signing_secret)) {
    throw new Error(`Resend webhook ${id} is not an enabled delivery webhook at the target URL with a signing secret`);
  }
  return found as ResendWebhook & { signing_secret: string };
}

/**
 * Resend returns a webhook's signing secret on retrieval, so an interrupted
 * apply resumes from remote state instead of an idempotency key (the webhook
 * API documents none). An existing destination still requires an explicit,
 * reviewed rotation so the stored secret never silently changes owner.
 */
export async function configureResendWebhook(input: ConfigureResendWebhookInput): Promise<ResendWebhookPlan> {
  const url = resendWebhookUrl(input.url);
  if (!input.apiKey.startsWith("re_") || input.apiKey.length <= 3) throw new Error("Resend management key must start with re_");
  if (input.replaceWebhookId && !webhookId.test(input.replaceWebhookId)) throw new Error("replacement webhook ID is invalid");
  if (input.resume && !input.apply) throw new Error("--resume is only valid with --apply");
  if (input.apply && !input.persistSecret) throw new Error("encrypted secret persistence is required before creating a webhook");
  const request = input.request ?? fetch;
  const matching = (await listWebhooks(input.apiKey, request)).filter((webhook) => webhook.endpoint === url);
  const enabled = matching.filter((webhook) => webhook.status === "enabled");
  const ids = enabled.map((webhook) => webhook.id);
  const old = input.replaceWebhookId ? matching.find((webhook) => webhook.id === input.replaceWebhookId) : undefined;
  if (input.replaceWebhookId && (!old || (old.status !== "enabled" && !(input.resume && old.status === "disabled")))) {
    throw new Error("named old Resend webhook is not enabled at the exact target URL (or already disabled during this resumed operation)");
  }
  const classification = input.replaceWebhookId ? (enabled.length === 1 || (input.resume && enabled.length === 2) ? "rotate" : "blocked")
    : enabled.length === 0 || (input.resume && enabled.length === 1) ? "create" : enabled.length === 1 ? "needs_rotation" : "blocked";
  const plan: ResendWebhookPlan = { classification, url, environment: input.environment, enabledWebhookIds: ids,
    ...(classification === "needs_rotation" ? { reason: "a webhook already targets this URL; name it with --replace-webhook-id to rotate it" } : {}),
    ...(classification === "blocked" ? { reason: "multiple enabled webhooks or an ambiguous replacement; review Resend webhooks before applying" } : {}),
  };
  if (!input.apply) return plan;
  if (classification === "needs_rotation" || classification === "blocked") throw new Error(plan.reason);
  // A resumed operation adopts the webhook it created earlier: the one enabled
  // webhook at the URL that is not the named old one.
  const previous = input.resume ? enabled.filter((webhook) => webhook.id !== old?.id) : [];
  let created: ResendWebhook & { signing_secret: string };
  if (previous.length === 1) created = await retrieveWebhook(input.apiKey, previous[0]!.id, url, request);
  else if (previous.length === 0) {
    const response = await resendRequest<{ id?: string; signing_secret?: string }>(input.apiKey, "/webhooks", request, {
      method: "POST", body: JSON.stringify({ endpoint: url, events: [...RESEND_DELIVERY_EVENTS] }),
    });
    if (!response.id || !webhookId.test(response.id)) throw new Error("Resend did not return a webhook ID");
    created = await retrieveWebhook(input.apiKey, response.id, url, request);
    if (response.signing_secret !== created.signing_secret) throw new Error(`Resend webhook ${response.id} returned inconsistent signing secrets; review before storing`);
  } else throw new Error("remote webhook state changed; review Resend webhooks before resuming");
  try { await input.persistSecret!(created.signing_secret); }
  catch { throw new Error(`Resend webhook ${created.id} exists, but encrypted secret storage failed; rerun with --resume${old ? ` --replace-webhook-id ${old.id}` : ""}`); }
  if (old && old.id !== created.id && old.status === "enabled") {
    try {
      const disabled = await resendRequest<{ id?: string }>(input.apiKey, `/webhooks/${old.id}`, request, {
        method: "PATCH", body: JSON.stringify({ status: "disabled" }),
      });
      if (disabled.id !== old.id) throw new Error("unexpected webhook response");
    } catch {
      throw new Error(`Resend webhook ${created.id} is configured, but old webhook ${old.id} could not be disabled; rerun with --resume --replace-webhook-id ${old.id}`);
    }
  }
  return { ...plan, createdWebhookId: created.id, ...(old && old.id !== created.id ? { disabledWebhookId: old.id } : {}) };
}

/** Whether the deployed URL has exactly the enabled webhook whose signing secret is stored. Never returns the secret. */
export async function inspectResendWebhook(apiKey: string, value: string, storedSecret: string | undefined, request: typeof fetch = fetch): Promise<ResendWebhookStatus> {
  const url = resendWebhookUrl(value);
  const enabled = (await listWebhooks(apiKey, request)).filter((webhook) => webhook.endpoint === url && webhook.status === "enabled");
  if (enabled.length !== 1) return { url, found: enabled.length > 0, enabled: false, eventsMatch: false, secretMatches: false };
  const found = await resendRequest<ResendWebhook>(apiKey, `/webhooks/${enabled[0]!.id}`, request);
  return { url, found: true, enabled: found.status === "enabled", eventsMatch: subscribed(found),
    secretMatches: Boolean(storedSecret && found.signing_secret && found.signing_secret === storedSecret) };
}
