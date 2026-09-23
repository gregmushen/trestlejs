import assert from "node:assert/strict";
import { test } from "node:test";

import { assertOperationalHealth } from "./smoke-operational.mjs";

const enabled = { queues: true, r2: true, workflows: true };

function health(capabilities = enabled) {
  return {
    status: "ok",
    environment: "preview",
    capabilities: {
      database: { configured: true },
      email: { mode: "resend", configured: true, stagingProtected: true },
      billing: { mode: "test", configured: true },
      queues: { configured: capabilities.queues },
      artifacts: { mode: capabilities.r2 ? "r2" : "unavailable", configured: capabilities.r2 },
      workflows: { enabled: capabilities.workflows, configured: capabilities.workflows },
    },
  };
}

test("deployed smoke accepts async bindings that match declared capabilities", () => {
  assert.doesNotThrow(() => assertOperationalHealth(health(), "preview", enabled));
  const disabled = { queues: false, r2: false, workflows: false };
  assert.doesNotThrow(() => assertOperationalHealth(health(disabled), "preview", disabled));
});

test("deployed smoke fails closed on missing or unexpected Queue, R2, and Workflow bindings", () => {
  for (const capability of ["queues", "r2", "workflows"]) {
    const missing = health({ ...enabled, [capability]: false });
    assert.throws(() => assertOperationalHealth(missing, "preview", enabled), new RegExp(capability === "r2" ? "R2" : capability === "queues" ? "Queue" : "Workflow", "u"));
    const unexpected = health({ ...enabled, [capability]: true });
    const declared = { ...enabled, [capability]: false };
    assert.throws(() => assertOperationalHealth(unexpected, "preview", declared), new RegExp(capability === "r2" ? "R2" : capability === "queues" ? "Queue" : "Workflow", "u"));
  }
  const stale = health();
  delete stale.capabilities.queues;
  assert.throws(() => assertOperationalHealth(stale, "preview", enabled), /Queue binding/u);
});

test("deployed smoke still rejects unsafe provider modes before async checks", () => {
  const unsafe = health();
  unsafe.capabilities.billing.mode = "live";
  assert.throws(() => assertOperationalHealth(unsafe, "preview", enabled), /Stripe test adapter/u);
});
