import { describe, expect, it } from "vitest";

import { settleAdjacentConflicts } from "../src/upgrade-source.js";

const block = (application: string[], base: string[], target: string[]) =>
  ["<<<<<<< application", ...application, "||||||| previous template", ...base, "=======", ...target, ">>>>>>> new template"].join("\n");

describe("three-way merge conflict settlement", () => {
  it("keeps both sides when both only inserted at the same place, framework text first", () => {
    expect(settleAdjacentConflicts(["top", block(["import app;"], [], ["import framework;"]), "bottom"].join("\n"))).toEqual({ text: "top\nimport framework;\nimport app;\nbottom", conflicts: false });
  });

  it("applies the framework's change around lines the application only inserted", () => {
    const merged = settleAdjacentConflicts(block(["app.route(\"/\", articleRoutes);", "", "type Env = A;"], ["type Env = A;"], ["type Env = A & B;"]));
    expect(merged).toEqual({ text: "app.route(\"/\", articleRoutes);\n\ntype Env = A & B;", conflicts: false });
  });

  it("merges two insertions into one line", () => {
    const merged = settleAdjacentConflicts(block(["children([articleRoute, indexRoute, signInRoute])"], ["children([indexRoute, signInRoute])"], ["children([indexRoute, signInRoute, supportRoute])"]));
    expect(merged).toEqual({ text: "children([articleRoute, indexRoute, signInRoute, supportRoute])", conflicts: false });
  });

  it("merges an in-line insertion that comes with inserted lines", () => {
    const merged = settleAdjacentConflicts(block(["const article = route();", "children([article, index])"], ["children([index])"], ["children([index, support])"]));
    expect(merged).toEqual({ text: "const article = route();\nchildren([article, index, support])", conflicts: false });
  });

  it("recognizes an application that already contains the framework's version", () => {
    const merged = settleAdjacentConflicts(block(["export * from \"./health.js\";", "export * from \"./resources/article.js\";"], ["const health = 1;"], ["export * from \"./health.js\";"]));
    expect(merged).toEqual({ text: "export * from \"./health.js\";\nexport * from \"./resources/article.js\";", conflicts: false });
  });

  it("applies a framework deletion next to lines the application inserted", () => {
    const merged = settleAdjacentConflicts(block(["app.route(\"/\", articleRoutes);", "type Env = A;"], ["type Env = A;"], []));
    expect(merged).toEqual({ text: "app.route(\"/\", articleRoutes);", conflicts: false });
  });

  it("leaves real conflicts marked", () => {
    const merged = settleAdjacentConflicts(block(["const limit = 10;"], ["const limit = 5;"], ["const limit = 20;"]));
    expect(merged.conflicts).toBe(true);
    expect(merged.text).toContain("<<<<<<< application");
  });
});

describe("migration snapshot merge", () => {
  it("lays application schema changes over the target's and reports real conflicts", async () => {
    const { mergeSnapshots } = await import("../src/upgrade-migrations.js");
    const base = { tables: { "public.a": { columns: { id: {} } } } };
    const application = { tables: { "public.a": { columns: { id: {} } }, "public.article": { columns: { id: {} } } } };
    const target = { tables: { "public.a": { columns: { id: {}, added: {} } }, "public.job": { columns: {} } } };
    const conflicts: string[] = [];
    expect(mergeSnapshots(base, application, target, "$", conflicts)).toEqual({ tables: { "public.a": { columns: { id: {}, added: {} } }, "public.article": { columns: { id: {} } }, "public.job": { columns: {} } } });
    expect(conflicts).toEqual([]);
    mergeSnapshots({ v: 1 }, { v: 2 }, { v: 3 }, "$", conflicts);
    expect(conflicts).toEqual(["$.v"]);
  });
});
