export async function fetchSameOrigin(url, options = {}, maximumRedirects = 5) {
  const initial = new URL(url);
  let current = initial;
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(current, { ...options, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    if (redirects >= maximumRedirects) throw new Error(`Too many redirects for ${initial.pathname}`);
    const location = response.headers.get("location");
    if (!location) throw new Error(`Redirect for ${initial.pathname} did not include a location`);
    const target = new URL(location, current);
    if (target.origin !== initial.origin) throw new Error(`Cross-origin redirect rejected for ${initial.pathname}`);
    current = target;
  }
}

/** Newly deployed Pages origins can briefly return Cloudflare 52x while the
 * edge propagates. Retry only read-only requests and only transient gateway
 * responses; persistent failures remain visible after a bounded wait. */
export async function fetchSameOriginWithRetry(url, options = {}, { attempts = 6, delayMs = 2_000 } = {}) {
  const method = (options.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return fetchSameOrigin(url, options);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchSameOrigin(url, options);
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === attempts) throw error;
    }
    if (response && ![502, 503, 504, 520, 521, 522, 523, 524].includes(response.status)) return response;
    if (attempt === attempts && response) return response;
    await new Promise((resolve) => setTimeout(resolve, delayMs * Math.min(attempt, 4)));
  }
  throw new Error("Unreachable smoke retry state");
}
