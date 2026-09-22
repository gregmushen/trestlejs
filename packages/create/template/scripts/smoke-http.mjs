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
