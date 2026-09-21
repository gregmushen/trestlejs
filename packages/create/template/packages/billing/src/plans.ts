export const plans = {
  starter: { entitlements: ["workspace.single", "article.basic"] },
  pro: { entitlements: ["workspace.single", "article.basic", "workflows.advanced", "members.unlimited"] },
  business: { entitlements: ["workspace.single", "article.basic", "workflows.advanced", "members.unlimited", "support.priority"] },
} as const;

export type PlanName = keyof typeof plans;
export type Entitlement = (typeof plans)[PlanName]["entitlements"][number];
export const planEntitlements: Record<PlanName, readonly Entitlement[]> = { starter: plans.starter.entitlements, pro: plans.pro.entitlements, business: plans.business.entitlements };
