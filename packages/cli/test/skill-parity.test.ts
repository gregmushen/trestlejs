import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const canonical = path.join(repo, "skills/trestle-setup");
const templated = path.join(repo, "packages/create/template/.agents/skills/trestle-setup");

async function files(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(directory, path.join(prefix, entry.name)) : [path.join(prefix, entry.name)]))).flat().sort();
}

describe("setup skill", () => {
  it("ships the canonical skill in the template, adding only the managed-guidance marker", async () => {
    expect(await files(templated)).toEqual(await files(canonical));
    for (const file of await files(canonical)) {
      const template = (await readFile(path.join(templated, file), "utf8")).replace(/<!-- trestle-managed-guidance:\d+ -->\n\n/u, "");
      expect(template, file).toBe(await readFile(path.join(canonical, file), "utf8"));
    }
  });
});
