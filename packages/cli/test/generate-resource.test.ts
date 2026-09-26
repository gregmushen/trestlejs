import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parseResourceField } from "../src/generate-resource.js";

describe("resource field definitions", () => {
  it("parses scalar and relationship fields with migration-safe optionality", () => {
    expect(parseResourceField("summary:text?")).toEqual({ name: "summary", type: "text", required: false });
    expect(parseResourceField("authorId:relation?:Author:set-null")).toEqual({ name: "authorId", type: "relation", required: false, references: { resource: "Author", onDelete: "set-null" } });
    expect(() => parseResourceField("authorId:relation:Author:cascade")).toThrow("must initially be optional");
    expect(() => parseResourceField("bad-name:string?")).toThrow("invalid field");
    expect(() => parseResourceField("revision:integer?")).toThrow("reserved");
  });

  it("parses json, decimal, and enum fields with their shapes", () => {
    expect(parseResourceField("meta:json?")).toEqual({ name: "meta", type: "json", required: false });
    expect(parseResourceField("price:decimal(10,2)?")).toEqual({ name: "price", type: "decimal", required: false, precision: 10, scale: 2 });
    expect(parseResourceField("status:enum(draft|published)?")).toEqual({ name: "status", type: "enum", required: false, values: ["draft", "published"] });
    expect(() => parseResourceField("price:decimal?")).toThrow("decimal(precision,scale)");
    expect(() => parseResourceField("price:decimal(2,3)?")).toThrow("scale");
    expect(() => parseResourceField("status:enum()?")).toThrow("enum(value|value)");
    expect(() => parseResourceField("status:enum(Draft|draft)?")).toThrow("enum values");
    expect(() => parseResourceField("status:enum(draft|draft)?")).toThrow("enum values");
    expect(() => parseResourceField("meta:json?:Author")).toThrow("cannot reference");
  });

  it("keeps a Drizzle snapshot aligned with the latest base migration", async () => {
    const metadata = path.resolve("packages/create/template/packages/db/migrations/meta");
    const journal = JSON.parse(await readFile(path.join(metadata, "_journal.json"), "utf8")) as { entries: Array<{ idx: number }> };
    const latest = journal.entries.at(-1);
    expect(latest).toBeDefined();
    const snapshotPath = path.join(metadata, `${String(latest!.idx).padStart(4, "0")}_snapshot.json`);
    await expect(access(snapshotPath)).resolves.toBeUndefined();
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as { tables: Record<string, unknown> };
    expect(snapshot.tables).toHaveProperty("public.organization_entitlement_override");
  });
});
