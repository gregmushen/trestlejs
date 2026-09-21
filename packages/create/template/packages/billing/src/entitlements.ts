export class Entitlements {
  constructor(private readonly values: ReadonlySet<string>) {}
  has(value: string): boolean { return this.values.has(value); }
  require(value: string): void { if (!this.has(value)) throw new Error(`Missing entitlement: ${value}`); }
  list(): string[] { return [...this.values].sort(); }
}
