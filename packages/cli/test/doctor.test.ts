import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";

import { loadProjectManifest } from "@trestlejs/core";
import { describe, expect, it } from "vitest";

import { runDoctor } from "../src/doctor.js";
import { encryptSecrets } from "../src/secrets.js";

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

  it("fails enabled remote capabilities when their Worker bindings are absent", async () => {
    const manifest = await loadProjectManifest(templateRoot);
    const enabled = { ...manifest, capabilities: { ...manifest.capabilities, queues: true, r2: true, workflows: true, durableObjects: true } };
    const report = await runDoctor(templateRoot, enabled, "preview");
    for (const capability of ["queues", "r2", "workflows", "durableObjects"] as const) {
      expect(report.checks).toContainEqual(expect.objectContaining({ id: `cloudflare.${capability}.binding`, status: "fail" }));
    }
  });

  it("requires a nontrivial encrypted artifact signing key only for remote R2", async () => {
    const manifest = await loadProjectManifest(templateRoot);
    const enabled = { ...manifest, capabilities: { ...manifest.capabilities, r2: true } };
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-artifact-doctor-"));
    const key = randomBytes(32).toString("hex");
    try {
      await mkdir(path.join(root, "config", "credentials"), { recursive: true });
      for (const [secret, status] of [["", "fail"], ["short", "fail"], ["a".repeat(32), "pass"]] as const) {
        await writeFile(path.join(root, "config", "credentials", "preview.yml.enc"), encryptSecrets(secret ? { ARTIFACT_SIGNING_SECRET: secret } : {}, "preview", key));
        const report = await runDoctor(root, enabled, "preview", key);
        expect(report.checks).toContainEqual(expect.objectContaining({ id: "artifacts.signing_secret.configured", status }));
        expect(JSON.stringify(report)).not.toContain(secret === "" ? "unrelated-test-secret" : secret);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
