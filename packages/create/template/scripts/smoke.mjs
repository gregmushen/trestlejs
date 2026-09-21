const apiURL = process.env.API_URL;
const appURL = process.env.APP_URL;
const siteURL = process.env.SITE_URL;
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

if (siteURL) {
  for (const route of ["/", "/features", "/pricing", "/about", "/privacy", "/terms", "/robots.txt"]) {
    const response = await fetch(`${siteURL}${route}`, { redirect: "manual" });
    if (!response.ok) throw new Error(`Site smoke failed for ${route}: ${response.status}`);
  }
  const homepage = await (await fetch(siteURL)).text();
  if (!homepage.includes(`${appURL}/sign-in`) || !homepage.includes(`${appURL}/sign-up`)) {
    throw new Error("Site authentication links do not point to APP_URL");
  }
}

console.log(`Smoke passed for ${[siteURL, appURL, apiURL].filter(Boolean).join(", ")}`);
