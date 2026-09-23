import type { MeteredDefinition } from "./features.js";
import type { EffectiveEntitlement } from "./effective.js";

export type UsagePeriod = Readonly<{ start: Date; end: Date }>;

export type QuotaState = Readonly<{
  code: string;
  used: number;
  requested: number;
  included: number;
  limit: number | null;
  enforcement: "hard" | "soft";
  overage: "block" | "allow" | "bill";
  remainingIncluded: number;
  overageUnits: number;
  allowed: boolean;
  exceeded: boolean;
  period: { start: string; end: string };
}>;

/** Calendar periods in UTC. */
export function periodBounds(period: MeteredDefinition["period"], now: Date): UsagePeriod {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  if (period === "day") return { start: new Date(Date.UTC(year, month, day)), end: new Date(Date.UTC(year, month, day + 1)) };
  if (period === "month") return { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) };
  return { start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year + 1, 0, 1)) };
}

/**
 * Usage evaluation is separate from authorization: a request may be
 * authorized and still be refused because a hard quota is exhausted.
 */
export function evaluateQuota(entitlement: EffectiveEntitlement | undefined, used: number, period: UsagePeriod, requested = 1): QuotaState {
  const code = entitlement?.code ?? "unknown";
  const values = entitlement?.enabled ? entitlement.values : {};
  const included = typeof values.included === "number" ? values.included : 0;
  const limit = values.limit === null ? null : typeof values.limit === "number" ? values.limit : entitlement?.enabled ? included : 0;
  const enforcement = values.enforcement === "soft" ? "soft" : "hard";
  const overage = values.overage === "allow" || values.overage === "bill" ? values.overage : "block";
  const next = used + requested;
  const overLimit = limit !== null && next > limit;
  const overIncluded = next > included;
  const allowed = Boolean(entitlement?.enabled) && !(overLimit && enforcement === "hard") && !(overIncluded && overage === "block");
  return {
    code, used, requested, included, limit, enforcement, overage,
    remainingIncluded: Math.max(0, included - used),
    overageUnits: Math.max(0, next - Math.max(included, used)),
    allowed,
    exceeded: overLimit,
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
  };
}
