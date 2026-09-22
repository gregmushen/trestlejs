export function assertOperationalHealth(health, environment) {
  if (!health || health.status !== "ok" || health.environment !== environment) {
    throw new Error(`Worker operational environment does not match ${environment}`);
  }
  if (!health.capabilities?.database?.configured) throw new Error("Worker database binding is not configured");
  if (health.capabilities.email?.mode !== "resend" || !health.capabilities.email.configured) {
    throw new Error("Worker Resend email adapter is not configured");
  }
  if (environment !== "production" && !health.capabilities.email.stagingProtected) {
    throw new Error("Worker email recipient protection is not configured");
  }
  const expectedBillingMode = environment === "production" ? "live" : "test";
  if (health.capabilities.billing?.mode !== expectedBillingMode || !health.capabilities.billing.configured) {
    throw new Error(`Worker Stripe ${expectedBillingMode} adapter is not configured`);
  }
}
