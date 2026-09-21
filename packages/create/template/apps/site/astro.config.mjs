import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.SITE_URL ?? "http://localhost:42068",
  output: "static",
  integrations: [sitemap()],
  vite: { plugins: [tailwindcss()] },
});
