export type DomainId<Resource extends string> = string & {
  readonly __resource: Resource;
};
