import path from "node:path";

import { loadProjectManifest } from "@trestlejs/core";
import { describe, expect, it } from "vitest";

import { runDoctor } from "../src/doctor.js";

const templateRoot = path.resolve("packages/create/template");

describe("remote provider preflight", () => {
  it("declares preview Stripe keys and rejects unconfigured preview providers", async () => {
    const manifest = await loadProjectManifest(templateRoot);
    expect(manifest.secrets?.STRIPE_SECRET_KEY?.required).toContain("preview");
    expect(manifest.secrets?.STRIPE_WEBHOOK_SECRET?.required).toContain("preview");
    const report = await runDoctor(templateRoot, manifest, "preview");
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "email.secret.resend_api_key.declared", status: "pass" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "billing.secret.stripe_secret_key.declared", status: "pass" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "email.provider.configuration", status: "fail" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "billing.stripe.configuration", status: "fail" }));
  });
});
