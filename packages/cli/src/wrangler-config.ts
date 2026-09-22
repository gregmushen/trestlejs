import type { EnvironmentName } from "@trestlejs/core";

function objectForKey(source: string, key: string, start = 0): string | undefined {
  const keyIndex = source.indexOf(`"${key}"`, start);
  if (keyIndex < 0) return undefined;
  const open = source.indexOf("{", source.indexOf(":", keyIndex));
  if (open < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return source.slice(open, index + 1);
  }
  return undefined;
}

export function wranglerEnvironmentBlock(source: string, environment: EnvironmentName): string {
  if (environment === "local") return objectForKey(source, "vars") ?? "";
  const environments = objectForKey(source, "env");
  return environments ? objectForKey(environments, environment) ?? "" : "";
}

export function wranglerStringVariable(block: string, name: string): string | undefined {
  return block.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`, "u"))?.[1];
}
