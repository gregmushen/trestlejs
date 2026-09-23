import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Whether the project manifest enables the optional platform admin. */
export function adminEnabled(manifestSource) {
  const section = manifestSource.match(/^capabilities:\s*\n((?:^[ \t]+.*\n|^\s*\n)*)/mu)?.[1];
  if (!section || !/^  admin: (?:true|false)(?:\s+#.*)?$/mu.test(section)) throw new Error("project manifest must declare capabilities.admin");
  return /^  admin: true(?:\s+#.*)?$/mu.test(section);
}

/**
 * Deployed platform admin checks: the API is live, rejects anonymous and
 * sign-up requests, trusts only the admin origin, and the SPA is not indexed.
 */
export async function smokeAdmin({ adminURL, adminApiURL }, fetchImpl = fetch) {
  const live = await fetchImpl(`${adminApiURL}/api/admin/health/live`);
  if (!live.ok) throw new Error(`Admin API liveness failed: ${live.status}`);
  const session = await fetchImpl(`${adminApiURL}/api/admin/session`, { headers: { origin: adminURL } });
  if (session.status !== 401) throw new Error(`Anonymous admin session was not rejected: ${session.status}`);
  if (session.headers.get("access-control-allow-origin") !== adminURL) throw new Error("Admin API CORS origin is incorrect");
  const signUp = await fetchImpl(`${adminApiURL}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: adminURL }, body: "{}" });
  if (signUp.status !== 404) throw new Error(`Admin origin exposes sign-up: ${signUp.status}`);
  const spa = await fetchImpl(`${adminURL}/`);
  if (!spa.ok) throw new Error(`Admin SPA failed: ${spa.status}`);
  if (!(spa.headers.get("x-robots-tag") ?? "").includes("noindex")) throw new Error("Admin SPA is missing X-Robots-Tag noindex");
}

async function main() {
  const [operation] = process.argv.slice(2);
  const manifest = await readFile(new URL("../.trestle/project.yaml", import.meta.url), "utf8");
  const enabled = adminEnabled(manifest);
  if (operation === "status") {
    process.stdout.write(`enabled=${enabled}\n`);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `enabled=${enabled}\n`);
    return;
  }
  if (operation !== "smoke") throw new Error("expected status or smoke");
  if (!enabled) throw new Error("capabilities.admin is false; there is no platform admin to smoke");
  const adminURL = process.env.ADMIN_URL?.replace(/\/$/u, "");
  const adminApiURL = process.env.ADMIN_API_URL?.replace(/\/$/u, "");
  if (!adminURL || !adminApiURL) throw new Error("ADMIN_URL and ADMIN_API_URL are required");
  await smokeAdmin({ adminURL, adminApiURL });
  console.log(`Platform admin smoke passed for ${adminURL}, ${adminApiURL}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
