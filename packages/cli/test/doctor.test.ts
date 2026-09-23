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

  it("fails closed when native webhook mode lacks its Queue or encrypted signing key", async () => {
    const manifest = await loadProjectManifest(templateRoot);
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-native-webhook-doctor-"));
    const key = randomBytes(32).toString("hex");
    try {
      await mkdir(path.join(root, "apps", "worker"), { recursive: true });
      await mkdir(path.join(root, "config", "credentials"), { recursive: true });
      await writeFile(path.join(root, "apps", "worker", "wrangler.jsonc"), JSON.stringify({ env: { preview: { vars: { WEBHOOK_DELIVERY_MODE: "native" } } } }));
      await writeFile(path.join(root, "config", "credentials", "preview.yml.enc"), encryptSecrets({}, "preview", key));
      const missing = await runDoctor(root, manifest, "preview", key);
      expect(missing.checks).toContainEqual(expect.objectContaining({ id: "webhook.native.configuration", status: "fail" }));
      expect(missing.checks).toContainEqual(expect.objectContaining({ id: "webhook.native.signing_secret.configured", status: "fail" }));

      const enabled = { ...manifest, capabilities: { ...manifest.capabilities, queues: true }, secrets: {
        ...manifest.secrets, WEBHOOK_SECRET_KEY: { target: "worker" as const, required: ["preview" as const] },
      } };
      await writeFile(path.join(root, "apps", "worker", "wrangler.jsonc"), JSON.stringify({ env: { preview: {
        vars: { WEBHOOK_DELIVERY_MODE: "native" },
        queues: { producers: [{ binding: "TRESTLE_EVENTS", queue: "example" }], consumers: [{ queue: "example", dead_letter_queue: "example-dlq" }] },
      } } }));
      await writeFile(path.join(root, "config", "credentials", "preview.yml.enc"), encryptSecrets({ WEBHOOK_SECRET_KEY: "a".repeat(32) }, "preview", key));
      const ready = await runDoctor(root, enabled, "preview", key);
      expect(ready.checks).toContainEqual(expect.objectContaining({ id: "webhook.native.configuration", status: "pass" }));
      expect(ready.checks).toContainEqual(expect.objectContaining({ id: "webhook.native.signing_secret.configured", status: "pass" }));
      expect(JSON.stringify(ready)).not.toContain("a".repeat(32));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
