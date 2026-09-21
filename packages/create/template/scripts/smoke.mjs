const apiURL = process.env.API_URL;
const appURL = process.env.APP_URL;
if (!apiURL || !appURL) throw new Error("API_URL and APP_URL are required");

const health = await fetch(`${apiURL}/api/health`, { headers: { origin: appURL } });
if (!health.ok) throw new Error(`API health failed: ${health.status}`);
const healthBody = await health.json();
if (healthBody.status !== "ok") throw new Error("API health payload is invalid");
if (health.headers.get("access-control-allow-origin") !== appURL) throw new Error("API CORS origin is incorrect");

for (const route of ["/", "/sign-in"]) {
  const response = await fetch(`${appURL}${route}`, { redirect: "manual" });
  if (!response.ok) throw new Error(`Web smoke failed for ${route}: ${response.status}`);
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) throw new Error(`${route} did not return HTML`);
}

console.log(`Smoke passed for ${appURL} and ${apiURL}`);
