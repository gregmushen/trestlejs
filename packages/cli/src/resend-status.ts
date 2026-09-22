export type ResendSenderStatus = Readonly<{ domain: string; found: boolean; verified: boolean; providerStatus?: string }>;

export function senderDomain(sender: string): string {
  const address = sender.match(/<([^>]+)>/u)?.[1] ?? sender;
  const domain = address.trim().split("@")[1];
  if (!domain || !/^[a-z0-9.-]+$/iu.test(domain)) throw new Error("EMAIL_FROM must contain a valid email address");
  return domain.toLowerCase();
}

export async function inspectResendSender(apiKey: string, sender: string, request: typeof fetch = fetch): Promise<ResendSenderStatus> {
  const domain = senderDomain(sender);
  const response = await request("https://api.resend.com/domains", { headers: { authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`Resend API returned HTTP ${response.status}`);
  const body = await response.json() as { data?: Array<{ name?: string; status?: string }> };
  const record = body.data?.find((item) => item.name?.toLowerCase() === domain || domain.endsWith(`.${item.name?.toLowerCase() ?? ""}`));
  return { domain, found: Boolean(record), verified: record?.status === "verified", ...(record?.status ? { providerStatus: record.status } : {}) };
}
