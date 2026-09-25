import type { EnvironmentName } from "./core.js";

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

function arrayForKey(source: string, key: string): string | undefined {
  const keyIndex = source.indexOf(`"${key}"`);
  if (keyIndex < 0) return undefined;
  const open = source.indexOf("[", source.indexOf(":", keyIndex));
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
    else if (character === "[") depth += 1;
    else if (character === "]" && --depth === 0) return source.slice(open, index + 1);
  }
  return undefined;
}

export type CloudflareBindingCapability = "queues" | "r2" | "workflows" | "durableObjects";

export function wranglerCapabilityBinding(block: string, capability: CloudflareBindingCapability): boolean {
  if (capability === "queues") {
    const queue = objectForKey(block, "queues");
    const producer = queue ? arrayForKey(queue, "producers") : undefined;
    const consumer = queue ? arrayForKey(queue, "consumers") : undefined;
    return Boolean(producer?.match(/"binding"\s*:\s*"TRESTLE_EVENTS"/u) && producer?.match(/"queue"\s*:\s*"[^"]+"/u) && consumer?.match(/"queue"\s*:\s*"[^"]+"/u) && consumer?.match(/"dead_letter_queue"\s*:\s*"[^"]+"/u));
  }
  if (capability === "r2") {
    const buckets = arrayForKey(block, "r2_buckets");
    return Boolean(buckets?.match(/"binding"\s*:\s*"TRESTLE_ARTIFACTS"/u) && buckets?.match(/"bucket_name"\s*:\s*"[^"]+"/u));
  }
  if (capability === "workflows") {
    const workflows = arrayForKey(block, "workflows");
    return Boolean(workflows?.match(/"binding"\s*:\s*"TRESTLE_WORKFLOW"/u) && workflows?.match(/"class_name"\s*:\s*"[^"]+"/u));
  }
  const durableObjects = objectForKey(block, "durable_objects");
  return Boolean(durableObjects?.match(/"name"\s*:\s*"TRESTLE_STATE"/u) && durableObjects?.match(/"class_name"\s*:\s*"[^"]+"/u));
}

export function wranglerEnvironmentBlock(source: string, environment: EnvironmentName): string {
  if (environment === "local") return objectForKey(source, "vars") ?? "";
  const environments = objectForKey(source, "env");
  return environments ? objectForKey(environments, environment) ?? "" : "";
}

export function wranglerStringVariable(block: string, name: string): string | undefined {
  const encoded = block.match(new RegExp(`"${name}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, "u"))?.[1];
  if (!encoded) return undefined;
  try { return JSON.parse(encoded) as string; }
  catch { return undefined; }
}
