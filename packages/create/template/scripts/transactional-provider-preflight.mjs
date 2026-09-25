const resendKey = process.env.RESEND_API_KEY ?? "";
const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
const stripeMode = process.env.TRESTLE_STRIPE_MODE ?? "test";
const resendBase = (process.env.TRESTLE_RESEND_API_BASE ?? "https://api.resend.com").replace(/\/$/u, "");
const stripeBase = (process.env.TRESTLE_STRIPE_API_BASE ?? "https://api.stripe.com").replace(/\/$/u, "");

if (!resendKey.startsWith("re_")) throw new Error("RESEND_API_KEY must be a Resend API key");
if (!["test", "live"].includes(stripeMode)) throw new Error("TRESTLE_STRIPE_MODE must be test or live");
if (!new RegExp(`^(?:sk|rk)_${stripeMode}_[A-Za-z0-9_]+$`, "u").test(stripeKey)) {
  throw new Error(`STRIPE_SECRET_KEY must be a ${stripeMode}-mode Stripe secret or restricted key`);
}

async function request(url, key, provider) {
  let response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`${provider} credential check could not reach the provider API`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${provider} rejected the configured credential (HTTP ${response.status}); replace the encrypted environment secret with an active key`);
  }
  if (!response.ok) throw new Error(`${provider} credential check failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${provider} credential check returned an invalid response`);
  }
}

const domains = await request(`${resendBase}/domains`, resendKey, "Resend");
if (!Array.isArray(domains.data)) throw new Error("Resend credential check returned an invalid domain list");
const prices = await request(`${stripeBase}/v1/prices?limit=1`, stripeKey, "Stripe");
if (prices.object !== "list" || !Array.isArray(prices.data)) {
  throw new Error("Stripe credential check returned an invalid price list");
}
process.stdout.write("Resend and Stripe credentials are active and have required read access; values were not printed.\n");
