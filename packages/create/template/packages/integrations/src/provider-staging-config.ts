import { readFile } from "node:fs/promises";

export function parseStagingProviderVariables(source: string): Record<string, string> {
  const config = JSON.parse(source) as { env?: { staging?: { vars?: Record<string, unknown> } } };
  const variables = config.env?.staging?.vars;
  if (!variables || typeof variables !== "object" || Array.isArray(variables)
    || Object.values(variables).some((value) => typeof value !== "string")) {
    throw new Error("Staging Worker variables are missing or invalid");
  }
  return variables as Record<string, string>;
}

export async function readStagingProviderVariables(): Promise<Record<string, string>> {
  return parseStagingProviderVariables(await readFile(new URL("../../../apps/worker/wrangler.jsonc", import.meta.url), "utf8"));
}
