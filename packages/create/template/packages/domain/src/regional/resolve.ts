import { regionalSettings, type RegionalLayer, type RegionalSetting, type RegionalValues } from "./identifiers.js";

export type RegionalSource = "operation" | "user" | "organization" | "application";
export type ResolvedSetting = Readonly<{ value: string; source: RegionalSource }>;
export type RegionalContext = Readonly<Record<RegionalSetting, ResolvedSetting>>;

export type RegionalLayers = Readonly<{
  application: RegionalValues;
  organization?: RegionalLayer | null;
  user?: RegionalLayer | null;
  /** An explicit override for one operation, e.g. a report rendered in a named zone. */
  operation?: RegionalLayer | null;
}>;

export type ResolutionOptions = Readonly<{
  /** Currency is not a user preference unless the application offers display-currency selection. */
  userCurrency?: boolean;
}>;

/**
 * Resolves each setting independently: operation override, then user
 * preference, then organization default, then application default. Every
 * value carries the layer it came from.
 */
export function resolveRegionalContext(layers: RegionalLayers, options: ResolutionOptions = {}): RegionalContext {
  const pick = (setting: RegionalSetting): ResolvedSetting => {
    const candidates: Array<[RegionalSource, RegionalLayer | null | undefined]> = [
      ["operation", layers.operation],
      ["user", setting === "currency" && !options.userCurrency ? undefined : layers.user],
      ["organization", layers.organization],
    ];
    for (const [source, layer] of candidates) {
      const value = layer?.[setting];
      if (value) return { value, source };
    }
    return { value: layers.application[setting], source: "application" };
  };
  return Object.fromEntries(regionalSettings.map((setting) => [setting, pick(setting)])) as RegionalContext;
}

/** The plain effective values, for formatting. */
export function effectiveValues(context: RegionalContext): RegionalValues {
  return Object.fromEntries(regionalSettings.map((setting) => [setting, context[setting].value])) as RegionalValues;
}
