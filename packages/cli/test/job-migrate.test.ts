import { describe, expect, it } from "vitest";

import { migrationSteps } from "../src/job-migrate.js";

describe("job runtime migration steps", () => {
  it("orders switch, configure, deploy, drain, settle, and check, with a rollback", () => {
    const steps = migrationSteps("cloudflare", "trigger", "production");
    const index = (text: string) => steps.findIndex((step) => step.includes(text));
    expect(index("jobs use trigger --yes")).toBe(0);
    expect(index("TRIGGER_SECRET_KEY")).toBeLessThan(index("apps/jobs deploy"));
    expect(index("jobs env push --env production --yes")).toBeGreaterThan(0);
    expect(index("Deploy the Worker")).toBeGreaterThan(index("apps/jobs deploy"));
    expect(index("--settle --yes")).toBeGreaterThan(index("drain"));
    expect(index("--check")).toBeGreaterThan(index("--settle --yes"));
    expect(steps.at(-1)).toContain("--to cloudflare");
  });

  it("registers the Inngest endpoint when moving to Inngest and keeps the old runtime's runs going", () => {
    const steps = migrationSteps("trigger", "inngest", "staging").join("\n");
    expect(steps).toContain("INNGEST_SIGNING_KEY --env staging");
    expect(steps).toContain("/api/jobs/inngest");
    expect(steps).toContain("trigger keeps running its accepted runs");
  });

  it("returns to Cloudflare with its own switch command", () => {
    const steps = migrationSteps("inngest", "cloudflare", "local");
    expect(steps[0]).toContain("jobs use cloudflare --yes");
    expect(steps.join("\n")).toContain("trestle doctor --env local");
  });
});
