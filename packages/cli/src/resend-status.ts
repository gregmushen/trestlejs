export type ResendSenderStatus = Readonly<{ domain: string; found: boolean; verified: boolean; providerStatus?: string }>;

export type RemoteEmailEnvironment = "preview" | "staging" | "production";

export type EmailDeploymentConfiguration = Readonly<{
  environment: RemoteEmailEnvironment;
  mode?: string | undefined;
  apiKey?: string | undefined;
  webhookSecret?: string | undefined;
  sender?: string | undefined;
  recipientRedirect?: string | undefined;
}>;

export function senderDomain(sender: string): string {
  const address = sender.match(/<([^>]+)>/u)?.[1] ?? sender;
  const domain = address.trim().match(/^[^@\s<>]+@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,})$/iu)?.[1];
  if (!domain) throw new Error("EMAIL_FROM must contain a valid email address");
  return domain.toLowerCase();
}

export function validEmailAddress(value: string | undefined): boolean {
  if (!value || value === "CHANGE_ME") return false;
  try { senderDomain(value); return true; }
  catch { return false; }
}

export function emailDeploymentIssues(config: EmailDeploymentConfiguration): string[] {
  const problems: string[] = [];
  if (config.mode !== "resend") problems.push("EMAIL_DELIVERY_MODE must be resend");
  if (!config.apiKey?.startsWith("re_") || config.apiKey.length <= 3) problems.push("RESEND_API_KEY must start with re_");
  if (!config.webhookSecret?.startsWith("whsec_") || config.webhookSecret.length <= 6) problems.push("RESEND_WEBHOOK_SECRET must start with whsec_");
  if (!config.sender || config.sender === "CHANGE_ME") problems.push("EMAIL_FROM is not configured");
  else if (!validEmailAddress(config.sender)) problems.push("EMAIL_FROM must contain a valid email address");
  if (config.environment !== "production") {
    if (!config.recipientRedirect || config.recipientRedirect === "CHANGE_ME") problems.push(`${config.environment} recipient redirect is not configured`);
    else if (!validEmailAddress(config.recipientRedirect)) problems.push(`${config.environment} recipient redirect must be a valid email address`);
  }
  return problems;
}

export async function inspectResendSender(apiKey: string, sender: string, request: typeof fetch = fetch): Promise<ResendSenderStatus> {
  const domain = senderDomain(sender);
  const response = await request("https://api.resend.com/domains", { headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`Resend API returned HTTP ${response.status}`);
  const body = await response.json() as { data?: Array<{ name?: string; status?: string }> };
  const record = body.data?.find((item) => item.name?.toLowerCase() === domain || domain.endsWith(`.${item.name?.toLowerCase() ?? ""}`));
  return { domain, found: Boolean(record), verified: record?.status === "verified", ...(record?.status ? { providerStatus: record.status } : {}) };
}
