import type { EnvironmentName } from "@trestlejs/core";

export function workflowArguments(operation: "list" | "status" | "retry", name: string, id: string | undefined, environment: EnvironmentName, json = false): string[] {
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(name)) throw new Error("workflow name is invalid");
  if (id && !/^[A-Za-z0-9_-]{1,100}$|^latest$/u.test(id)) throw new Error("workflow instance ID is invalid");
  const target = environment === "local" ? ["--local"] : ["--env", environment];
  if (operation === "list") return ["workflows", "instances", "list", name, ...target, ...(json ? ["--json"] : [])];
  if (!id) throw new Error(`${operation} requires an instance ID`);
  if (operation === "status") return ["workflows", "instances", "describe", name, id, ...target, ...(json ? ["--json"] : [])];
  return ["workflows", "instances", "restart", name, id, ...target, ...(json ? ["--json"] : [])];
}
