export const featureDefinitions = {
  "workspace.single": { description: "One organization workspace", privileges: ["use"] },
  "article.basic": { description: "Core article publishing", privileges: ["read", "publish"] },
  "workflows.advanced": { description: "Advanced workflow automation", privileges: ["run", "manage"] },
  "members.unlimited": { description: "Unlimited organization members", privileges: ["invite"] },
  "support.priority": { description: "Priority support", privileges: ["request"] },
} as const;

export type FeatureCode = keyof typeof featureDefinitions;
export type FeaturePrivilege<Code extends FeatureCode> = (typeof featureDefinitions)[Code]["privileges"][number];
export type PlanLifecycle = "draft" | "active" | "grandfathered" | "retired";
export type PlanDefinition = Readonly<{ version: number; lifecycle: PlanLifecycle; entitlements: readonly FeatureCode[] }>;

export const plans = {
  starter: { version: 1, lifecycle: "active", entitlements: ["workspace.single", "article.basic"] },
  pro: { version: 1, lifecycle: "active", entitlements: ["workspace.single", "article.basic", "workflows.advanced", "members.unlimited"] },
  business: { version: 1, lifecycle: "active", entitlements: ["workspace.single", "article.basic", "workflows.advanced", "members.unlimited", "support.priority"] },
} as const satisfies Record<string, PlanDefinition>;

export type PlanName = keyof typeof plans;
export type Entitlement = FeatureCode;
export const planEntitlements: Record<PlanName, readonly Entitlement[]> = { starter: plans.starter.entitlements, pro: plans.pro.entitlements, business: plans.business.entitlements };
export function getPlan(name: string): PlanDefinition | undefined { return plans[name as PlanName]; }
