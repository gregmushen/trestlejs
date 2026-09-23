export type DomainId<Resource extends string> = string & {
  readonly __resource: Resource;
};

export * from "./access/index.js";
export * from "./notifications/index.js";
export * from "./webhooks/index.js";
