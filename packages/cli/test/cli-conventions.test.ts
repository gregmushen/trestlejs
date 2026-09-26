import { describe, expect, it } from "vitest";

import { commandInventory, createProgram } from "../src/cli.js";

const inventory = commandInventory(createProgram({ stdout: () => {}, stderr: () => {} }));

describe("CLI conventions", () => {
  it("describes every command and option", () => {
    expect(inventory.filter((entry) => !entry.description.trim()).map((entry) => entry.command)).toEqual([]);
    expect(inventory.flatMap((entry) => entry.options.filter((option) => !option.description.trim()).map((option) => `${entry.command} ${option.flags}`))).toEqual([]);
  });

  it("confirms changes only with --yes or --apply, and uses one name per concept", () => {
    const synonyms = ["--confirm", "--force", "--dry-run", "--environment", "--output-json", "--format-json", "--tenant-id", "--org"];
    expect(inventory.flatMap((entry) => entry.options.filter((option) => synonyms.some((flag) => option.flags.split(/[ ,]+/u).includes(flag))).map((option) => `${entry.command} ${option.flags}`))).toEqual([]);
    // With both, --apply performs the previewed change and --yes additionally confirms it targets production.
    const both = inventory.filter((entry) => entry.options.some((option) => option.flags.includes("--yes")) && entry.options.some((option) => option.flags.includes("--apply")));
    expect(both.filter((entry) => !/production/u.test(entry.options.find((option) => option.flags.includes("--yes"))!.description)).map((entry) => entry.command)).toEqual([]);
  });

  it("targets environments with --env", () => {
    const envOptions = inventory.flatMap((entry) => entry.options.filter((option) => /--env\b/u.test(option.flags)).map((option) => option.flags));
    expect(envOptions.length).toBeGreaterThan(10);
    expect(envOptions.every((flags) => flags.startsWith("--env <environment>"))).toBe(true);
  });

  it("marks experimental commands in their description", () => {
    for (const command of ["queue dlq list", "workflow list", "backup verify", "restore create", "console", "payments stripe seed"]) {
      expect(inventory.find((entry) => entry.command === command)?.experimental, command).toBe(true);
    }
    expect(inventory.find((entry) => entry.command === "doctor")?.experimental).toBe(false);
  });
});
