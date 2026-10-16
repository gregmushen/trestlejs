import { z } from "zod";

/** Pinned catalog schema observed October 16, 2026. No provider-config or
 * arbitrary JSON escape hatch: only the service contract qualified here. */
export const r2ConfigurationSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u),
  location_hint: z.enum(["wnam", "enam", "weur", "eeur", "apac", "oc"]).optional(),
}).strict();

export function serviceConfiguration(provider: string, service: string, value: unknown): Readonly<Record<string, string>> {
  if (provider !== "cloudflare" || service !== "r2:bucket") throw new Error("service configuration is unsupported for this provider/service");
  const parsed = r2ConfigurationSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid R2 configuration; expected a bucket name and optional location hint");
  return { name: parsed.data.name, ...(parsed.data.location_hint ? { location_hint: parsed.data.location_hint } : {}) };
}
