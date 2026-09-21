import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const output = path.join(root, "dist");

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  }))).flat();
}

describe("Southwind static output", () => {
  beforeAll(async () => {
    await execFileAsync("pnpm", ["exec", "astro", "build"], {
      cwd: root,
      env: {
        ...process.env,
        APP_URL: "http://localhost:42069",
        SITE_URL: "http://localhost:42068",
      },
    });
  }, 60_000);

  it("renders every required static route and discovery file", async () => {
    const files = await listFiles(output);
    for (const route of ["index.html", "features/index.html", "pricing/index.html", "about/index.html", "privacy/index.html", "terms/index.html", "404.html", "robots.txt", "sitemap-index.xml"]) {
      expect(files).toContain(path.join(output, route));
    }
    expect(files.some((file) => file.endsWith(".js"))).toBe(false);
  });

  it("uses the authenticated application origin for every account handoff", async () => {
    const home = await readFile(path.join(output, "index.html"), "utf8");
    const pricing = await readFile(path.join(output, "pricing", "index.html"), "utf8");
    expect(home).toContain('href="http://localhost:42069/sign-in"');
    expect(home).toContain('href="http://localhost:42069/sign-up"');
    expect(pricing).toContain('href="http://localhost:42069/sign-up?plan=starter"');
    expect(pricing).toContain('href="http://localhost:42069/sign-up?plan=pro"');
  });

  it("ships semantic navigation and complete page metadata", async () => {
    const pricing = await readFile(path.join(output, "pricing", "index.html"), "utf8");
    expect(pricing).toContain('aria-label="Primary navigation"');
    expect(pricing).toContain('aria-current="page"');
    expect(pricing).toContain('href="#content"');
    expect(pricing).toContain('<link rel="canonical" href="http://localhost:42068/pricing/">');
    expect(pricing).toContain('property="og:image"');
    expect(pricing).toContain('<main id="content">');
    expect(pricing).toContain("<footer");
  });
});
