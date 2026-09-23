export type PrivilegeType = "boolean" | "integer" | "decimal" | "string" | "select" | "duration";
export type PrivilegeValue = boolean | number | string | null;

export type PrivilegeDefinition = Readonly<{
  type: PrivilegeType;
  description?: string;
  options?: readonly string[];
  minimum?: number;
  /** Null values mean "unlimited" when a privilege allows them. */
  nullable?: boolean;
}>;

export type MeteredDefinition = Readonly<{ unit: string; period: "day" | "month" | "year" }>;

export type FeatureDefinition = Readonly<{
  name: string;
  description: string;
  privileges?: Readonly<Record<string, PrivilegeDefinition>>;
  /** Metered features receive included/limit/enforcement/overage privileges. */
  metered?: MeteredDefinition;
}>;

export type Feature = Readonly<{
  code: string;
  name: string;
  description: string;
  privileges: Readonly<Record<string, PrivilegeDefinition>>;
  metered?: MeteredDefinition;
}>;

export type FeatureCatalog<Code extends string = string> = Readonly<{
  codes: readonly Code[];
  has(code: string): code is Code;
  get(code: string): Feature | undefined;
  list(): Feature[];
}>;

export const featureCodePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const privilegeNamePattern = /^[a-z][a-zA-Z0-9]*$/u;
const durationPattern = /^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/u;

const meteredPrivileges: Readonly<Record<string, PrivilegeDefinition>> = {
  included: { type: "integer", minimum: 0, description: "Usage included each period" },
  limit: { type: "integer", minimum: 0, nullable: true, description: "Hard or soft ceiling; null is unlimited" },
  enforcement: { type: "select", options: ["hard", "soft"], description: "Whether the limit blocks usage" },
  overage: { type: "select", options: ["block", "allow", "bill"], description: "Behavior after included usage" },
};

export class FeatureDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeatureDefinitionError";
  }
}

export function defineFeatures<const Definitions extends Record<string, FeatureDefinition>>(definitions: Definitions): FeatureCatalog<Extract<keyof Definitions, string>> {
  type Code = Extract<keyof Definitions, string>;
  const features = new Map<string, Feature>();
  for (const [code, definition] of Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b))) {
    if (!featureCodePattern.test(code)) throw new FeatureDefinitionError(`Feature ${code} must be a lowercase dotted code`);
    const privileges = { ...(definition.privileges ?? {}) };
    if (definition.metered) {
      for (const name of Object.keys(meteredPrivileges)) if (name in privileges) throw new FeatureDefinitionError(`Metered feature ${code} reserves privilege ${name}`);
      Object.assign(privileges, meteredPrivileges);
    }
    for (const [name, privilege] of Object.entries(privileges)) {
      if (!privilegeNamePattern.test(name)) throw new FeatureDefinitionError(`Privilege ${code}.${name} must be camelCase`);
      if (privilege.type === "select" && !privilege.options?.length) throw new FeatureDefinitionError(`Select privilege ${code}.${name} requires options`);
      if (privilege.type !== "select" && privilege.options) throw new FeatureDefinitionError(`Privilege ${code}.${name} only accepts options when it is a select`);
    }
    features.set(code, { code, name: definition.name, description: definition.description, privileges, ...(definition.metered ? { metered: definition.metered } : {}) });
  }
  const codes = [...features.keys()] as Code[];
  return { codes, has: (code): code is Code => features.has(code), get: (code) => features.get(code), list: () => [...features.values()] };
}

export function validatePrivilegeValue(privilege: PrivilegeDefinition, value: unknown): string | undefined {
  if (value === null) return privilege.nullable ? undefined : "must not be null";
  switch (privilege.type) {
    case "boolean": return typeof value === "boolean" ? undefined : "must be a boolean";
    case "integer": return Number.isSafeInteger(value) && (privilege.minimum === undefined || (value as number) >= privilege.minimum) ? undefined : `must be an integer${privilege.minimum === undefined ? "" : ` >= ${privilege.minimum}`}`;
    case "decimal": return typeof value === "number" && Number.isFinite(value) && (privilege.minimum === undefined || value >= privilege.minimum) ? undefined : "must be a finite number";
    case "string": return typeof value === "string" && value.length > 0 && value.length <= 500 ? undefined : "must be a non-empty string";
    case "select": return typeof value === "string" && privilege.options!.includes(value) ? undefined : `must be one of ${privilege.options!.join(", ")}`;
    case "duration": return typeof value === "string" && durationPattern.test(value) ? undefined : "must be an ISO 8601 duration such as P30D";
  }
}

/** Validates entitlement values for one feature; unset privileges are allowed. */
export function validateEntitlementValues(catalog: FeatureCatalog, code: string, values: Readonly<Record<string, unknown>>): string[] {
  const feature = catalog.get(code);
  if (!feature) return [`${code} is not a defined feature`];
  const problems: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const privilege = feature.privileges[name];
    if (!privilege) { problems.push(`${code}.${name} is not a defined privilege`); continue; }
    const problem = validatePrivilegeValue(privilege, value);
    if (problem) problems.push(`${code}.${name} ${problem}`);
  }
  if (feature.metered && values.limit !== undefined && values.limit !== null && typeof values.included === "number" && (values.limit as number) < values.included) {
    problems.push(`${code}.limit must be at least the included usage`);
  }
  return problems;
}
