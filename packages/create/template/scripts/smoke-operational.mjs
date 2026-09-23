export function assertOperationalHealth(health, environment, declaredCapabilities = { queues: false, r2: false, workflows: false }) {
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
  if (health.capabilities.queues?.configured !== declaredCapabilities.queues) {
    throw new Error(`Worker Queue binding does not match declared ${environment} capability`);
  }
  const artifacts = health.capabilities.artifacts;
  if (declaredCapabilities.r2 ? artifacts?.mode !== "r2" || !artifacts.configured
    : artifacts?.mode !== "unavailable" || artifacts.configured !== false) {
    throw new Error(`Worker R2 artifact binding does not match declared ${environment} capability`);
  }
  const workflows = health.capabilities.workflows;
  if (workflows?.enabled !== declaredCapabilities.workflows
    || workflows?.configured !== declaredCapabilities.workflows) {
    throw new Error(`Worker Workflow binding does not match declared ${environment} capability`);
  }
}
