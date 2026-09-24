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

  it("requires every declared Stripe price and a safe return URL before reporting readiness", async () => {
    const manifest = await loadProjectManifest(templateRoot);
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-stripe-readiness-doctor-"));
    try {
      await mkdir(path.join(root, "apps", "worker"), { recursive: true });
      await mkdir(path.join(root, "packages", "billing"), { recursive: true });
      await writeFile(path.join(root, "packages", "billing", "stripe.json"), JSON.stringify({ schemaVersion: 1, currency: "usd", plans: {
        starter: { version: 1, name: "Starter", unitAmount: 1900, interval: "month" },
        pro: { version: 1, name: "Pro", unitAmount: 4900, interval: "month" },
      } }));
      const variables = { STRIPE_MODE: "test", STRIPE_PUBLISHABLE_KEY: "pk_test_example",
        STRIPE_PRICES: JSON.stringify({ pro: "price_pro" }), BILLING_RETURN_URL: "https://example.test/settings/billing" };
      const configPath = path.join(root, "apps", "worker", "wrangler.jsonc");
      await writeFile(configPath, JSON.stringify({ env: { preview: { vars: variables } } }));
      const incomplete = await runDoctor(root, manifest, "preview");
      expect(incomplete.checks).toContainEqual(expect.objectContaining({ id: "billing.stripe.configuration", status: "fail",
        evidence: expect.stringContaining("starter") }));
      await writeFile(configPath, JSON.stringify({ env: { preview: { vars: {
        ...variables, STRIPE_PRICES: JSON.stringify({ starter: "price_starter", pro: "price_pro" }),
      } } } }));
      const ready = await runDoctor(root, manifest, "preview");
      expect(ready.checks).toContainEqual(expect.objectContaining({ id: "billing.stripe.configuration", status: "pass" }));
      expect(JSON.stringify(ready)).not.toContain("pk_test_example");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("distinguishes readable but incomplete credentials from unreadable credentials", async () => {
    const manifest = await loadProjectManifest(templateRoot);
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-readable-secrets-doctor-"));
    const key = randomBytes(32).toString("hex");
    try {
      await mkdir(path.join(root, "config", "credentials"), { recursive: true });
      await writeFile(path.join(root, "config", "credentials", "preview.yml.enc"), encryptSecrets({}, "preview", key));
      const incomplete = await runDoctor(root, manifest, "preview", key);
      expect(incomplete.checks).toContainEqual(expect.objectContaining({
        id: "configuration.secrets.valid",
        status: "fail",
        message: expect.stringContaining("readable but required values are missing or undeclared"),
        evidence: expect.stringContaining("STRIPE_SECRET_KEY is required for preview"),
      }));
      const unreadable = await runDoctor(root, manifest, "preview", randomBytes(32).toString("hex"));
      expect(unreadable.checks).toContainEqual(expect.objectContaining({
        id: "configuration.secrets.valid",
        status: "fail",
        message: "preview encrypted credentials cannot be read",
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails enabled remote capabilities when their Worker bindings are absent", async () => {
    const manifest = await loadProjectManifest(templateRoot);
    const enabled = { ...manifest, capabilities: { ...manifest.capabilities, queues: true, r2: true, workflows: true, durableObjects: true } };
    const report = await runDoctor(templateRoot, enabled, "preview");
    for (const capability of ["queues", "r2", "workflows", "durableObjects"] as const) {
      expect(report.checks).toContainEqual(expect.objectContaining({ id: `cloudflare.${capability}.binding`, status: "fail" }));
    }
  });

  it("reports disabled and invalid ready-object retention without silently enabling deletion", async () => {
    const manifest = await loadProjectManifest(templateRoot);
    const enabled = { ...manifest, capabilities: { ...manifest.capabilities, r2: true } };
    const absent = await runDoctor(templateRoot, enabled, "preview");
    expect(absent.checks).toContainEqual(expect.objectContaining({ id: "artifacts.ready_retention.configuration", status: "pass", message: expect.stringContaining("indefinitely") }));
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-retention-doctor-"));
    try {
      await mkdir(path.join(root, "apps", "worker"), { recursive: true });
      await writeFile(path.join(root, "apps", "worker", "wrangler.jsonc"), JSON.stringify({ env: { preview: { vars: { ARTIFACT_READY_RETENTION_DAYS: "0" } } } }));
      const invalid = await runDoctor(root, enabled, "preview");
      expect(invalid.checks).toContainEqual(expect.objectContaining({ id: "artifacts.ready_retention.configuration", status: "fail" }));
      await writeFile(path.join(root, "apps", "worker", "wrangler.jsonc"), JSON.stringify({ env: { preview: { vars: { ARTIFACT_READY_RETENTION_DAYS: 30 } } } }));
      const nonString = await runDoctor(root, enabled, "preview");
      expect(nonString.checks).toContainEqual(expect.objectContaining({ id: "artifacts.ready_retention.configuration", status: "fail" }));
      await writeFile(path.join(root, "apps", "worker", "wrangler.jsonc"), JSON.stringify({ env: { preview: { vars: { ARTIFACT_READY_RETENTION_DAYS: "30" } } } }));
      const unbound = await runDoctor(root, enabled, "preview");
      expect(unbound.checks).toContainEqual(expect.objectContaining({ id: "artifacts.ready_retention.configuration", status: "fail", message: expect.stringContaining("requires an enabled R2 binding") }));
      await writeFile(path.join(root, "apps", "worker", "wrangler.jsonc"), JSON.stringify({ env: { preview: { vars: { ARTIFACT_READY_RETENTION_DAYS: "30" }, r2_buckets: [{ binding: "TRESTLE_ARTIFACTS", bucket_name: "test-artifacts" }] } } }));
      const ready = await runDoctor(root, enabled, "preview");
      expect(ready.checks).toContainEqual(expect.objectContaining({ id: "artifacts.ready_retention.configuration", status: "pass", message: expect.stringContaining("30 days") }));
    } finally {
      await rm(root, { recursive: true, force: true });
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
      expect(missing.checks).toContainEqual(expect.objectContaining({ id: "webhook.native.runtime.compatibility", status: "fail" }));
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
      expect(ready.checks).toContainEqual(expect.objectContaining({ id: "webhook.native.runtime.compatibility", status: "fail" }));
      expect(ready.checks).toContainEqual(expect.objectContaining({ id: "webhook.native.configuration", status: "pass" }));
      expect(ready.checks).toContainEqual(expect.objectContaining({ id: "webhook.native.signing_secret.configured", status: "pass" }));
      expect(JSON.stringify(ready)).not.toContain("a".repeat(32));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
