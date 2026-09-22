import type { EffectiveEntitlement } from "@__TRESTLE_PROJECT_NAME__/integrations";

export type EntitlementOverride = Readonly<{ code: string; enabled: boolean; reason: string; authorId: string; effectiveAt: Date; expiresAt?: Date }>;

export class Entitlements {
  private readonly decisions: Map<string, EffectiveEntitlement>;
  constructor(values: ReadonlySet<string>, options: { plan?: string; planVersion?: number; overrides?: readonly EntitlementOverride[]; now?: Date } = {}) {
    const now = options.now ?? new Date();
    const inheritedFrom = options.plan ? `${options.plan}@${options.planVersion ?? 1}` : undefined;
    this.decisions = new Map([...values].map((code) => [code, { code, enabled: true, source: "plan" as const, ...(inheritedFrom ? { inheritedFrom } : {}), effectiveAt: now }]));
    for (const override of options.overrides ?? []) {
      if (override.effectiveAt > now || (override.expiresAt && override.expiresAt <= now)) continue;
      this.decisions.set(override.code, { code: override.code, enabled: override.enabled, source: "override", inheritedFrom: override.reason, effectiveAt: override.effectiveAt });
    }
  }
  resolve(code: string): EffectiveEntitlement { return this.decisions.get(code) ?? { code, enabled: false, source: "default", effectiveAt: new Date(0) }; }
  has(value: string): boolean { return this.resolve(value).enabled; }
  require(value: string): void { if (!this.has(value)) throw new Error(`Missing entitlement: ${value}`); }
  list(): string[] { return [...this.decisions.values()].filter((item) => item.enabled).map((item) => item.code).sort(); }
  explain(): EffectiveEntitlement[] { return [...this.decisions.values()].sort((left, right) => left.code.localeCompare(right.code)); }
}
