import type { PrivilegeValue } from "./features.js";
import type { EffectiveEntitlement } from "./effective.js";

export class EntitlementRequiredError extends Error {
  constructor(readonly code: string) {
    super(`Missing entitlement: ${code}`);
    this.name = "EntitlementRequiredError";
  }
}

/** Read-only view over the local effective-entitlement projection. */
export class Entitlements {
  private readonly entries: ReadonlyMap<string, EffectiveEntitlement>;

  constructor(values: Iterable<EffectiveEntitlement> | ReadonlySet<string>) {
    const list: EffectiveEntitlement[] = [];
    for (const value of values) {
      list.push(typeof value === "string" ? { code: value, enabled: true, values: {}, source: "plan", effectiveAt: new Date(0).toISOString() } : value);
    }
    this.entries = new Map(list.map((entry) => [entry.code, entry]));
  }

  static none(): Entitlements { return new Entitlements([]); }

  has(code: string): boolean { return this.entries.get(code)?.enabled === true; }
  require(code: string): void { if (!this.has(code)) throw new EntitlementRequiredError(code); }
  get(code: string): EffectiveEntitlement | undefined { return this.entries.get(code); }
  value(code: string, privilege: string): PrivilegeValue | undefined { return this.has(code) ? this.entries.get(code)!.values[privilege] : undefined; }
  list(): string[] { return [...this.entries.values()].filter((entry) => entry.enabled).map((entry) => entry.code).sort(); }
  all(): EffectiveEntitlement[] { return [...this.entries.values()]; }
}
