import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { CliFailure } from "./runtime.js";

function names(input: string): { symbol: string; slug: string } {
  const words = input.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").split(/[^A-Za-z0-9]+/u).filter(Boolean);
  if (words.length === 0) throw new CliFailure("email name must contain letters or numbers");
  const symbol = words.map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`).join("");
  return { symbol, slug: words.map((word) => word.toLowerCase()).join("-") };
}

async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; } catch { return false; }
}

export async function generateEmail(root: string, input: string): Promise<string[]> {
  const { symbol, slug } = names(input);
  const directory = path.join(root, "packages", "integrations", "src", "email", "templates");
  await mkdir(directory, { recursive: true });
  const template = path.join(directory, `${slug}.tsx`);
  const fixture = path.join(directory, `${slug}.fixture.ts`);
  const test = path.join(directory, `${slug}.test.tsx`);
  for (const file of [template, fixture, test]) if (await exists(file)) throw new CliFailure(`refusing to overwrite ${path.relative(root, file)}`);
  await writeFile(template, `import React from "react";\nimport type { EmailTemplate } from "../types.js";\nimport { EmailLayout } from "./layout.js";\n\nexport type ${symbol}EmailProps = { name: string };\n\nexport function ${symbol[0]!.toLowerCase()}${symbol.slice(1)}Email(props: ${symbol}EmailProps): EmailTemplate<${symbol}EmailProps> {\n  return { name: "${slug}", props, render: () => <EmailLayout preview="${symbol}"><h1>${symbol}</h1><p>Hello {props.name},</p></EmailLayout> };\n}\n`);
  await writeFile(fixture, `import type { ${symbol}EmailProps } from "./${slug}.js";\n\nexport const ${symbol[0]!.toLowerCase()}${symbol.slice(1)}Fixture: ${symbol}EmailProps = { name: "Example User" };\n`);
  await writeFile(test, `import { describe, expect, it } from "vitest";\nimport { renderEmail } from "../render.js";\nimport { ${symbol[0]!.toLowerCase()}${symbol.slice(1)}Email } from "./${slug}.js";\nimport { ${symbol[0]!.toLowerCase()}${symbol.slice(1)}Fixture } from "./${slug}.fixture.js";\n\ndescribe("${slug} email", () => {\n  it("renders HTML and plain text", async () => {\n    const rendered = await renderEmail(${symbol[0]!.toLowerCase()}${symbol.slice(1)}Email(${symbol[0]!.toLowerCase()}${symbol.slice(1)}Fixture));\n    expect(rendered.html).toContain("${symbol}");\n    expect(rendered.text).toContain("Example User");\n  });\n});\n`);
  const barrel = path.join(directory, "../index.ts");
  const exportLine = `export * from "./templates/${slug}.js";`;
  if (!(await exists(barrel))) await writeFile(barrel, `${exportLine}\n`);
  else if (!(await readFile(barrel, "utf8")).includes(exportLine)) await appendFile(barrel, `${exportLine}\n`);
  return [template, fixture, test].map((file) => path.relative(root, file));
}
