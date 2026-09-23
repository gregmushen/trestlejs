import { defineFeatures } from "./features.js";

/**
 * Application-owned feature catalog. Features describe meaning and value
 * shape; plan versions and subscription overrides supply the values.
 */
export const features = defineFeatures({
  "workspace.single": { name: "Workspace", description: "One organization workspace" },
  "article.basic": { name: "Articles", description: "Create and manage articles" },
  "team.members": {
    name: "Team members",
    description: "Members who can belong to the organization",
    privileges: { maximum: { type: "integer", minimum: 1, nullable: true, description: "Maximum members; null is unlimited" } },
  },
  "workflows.advanced": { name: "Advanced workflows", description: "Publish and schedule workflow definitions" },
  "roles.custom": { name: "Custom roles", description: "Define organization-specific roles" },
  "api.access": {
    name: "API access",
    description: "Service accounts and scoped API keys",
    privileges: { maxKeys: { type: "integer", minimum: 1, description: "Active API keys per organization" } },
  },
  "api.requests": { name: "API requests", description: "Requests authenticated with API keys", metered: { unit: "request", period: "month" } },
  "support.priority": {
    name: "Priority support",
    description: "Faster support response",
    privileges: { responseTime: { type: "duration", description: "Target first response" } },
  },
});

export type FeatureCode = (typeof features.codes)[number];

/**
 * Provider meters for metered features (docs/INTEGRATION_STRATEGY.md §6).
 * Each stable feature code maps to exactly one OpenMeter meter slug or Lago
 * billable metric code; unmapped features stay native. Create the meter in
 * the provider with the same slug, event type, and a `$.quantity` value path.
 */
export const meterMappings = [
  { featureCode: "api.requests", meter: "api_requests", eventType: "api.requests" },
] as const satisfies ReadonlyArray<{ featureCode: FeatureCode; meter: string; eventType?: string; entitlementFeature?: string }>;
