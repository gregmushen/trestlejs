import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  const origin = site ?? new URL("http://localhost:42068");
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${new URL("sitemap-index.xml", origin).href}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
