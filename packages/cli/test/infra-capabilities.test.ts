import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COMMAND_EFFECTS, effectsOf, isRemoteReadOnly, MUTATING, resolveCapability, SUPPORTED_TOOLCHAIN } from "../src/infra/capabilities.js";
import { CATALOG_SERVICES, PROJECTS_CAPABILITIES } from "../src/infra/capability-matrix.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "stripe-projects");
const now = new Date("2026-10-02T00:00:00.000Z");

/** Credential shapes that must never appear in a checked-in fixture. */
const SECRET_PATTERNS = [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/u, /\bwhsec_[A-Za-z0-9]{8,}/u, /\bre_[A-Za-z0-9]{16,}/u, /postgres(?:ql)?:\/\/[^\s"]*:[^\s"@]+@/u, /"(?:password|secret|token|api_key)"\s*:\s*"[^"]+"/iu];

describe("Stripe Projects capability evidence", () => {
  it("keeps checked-in provider fixtures free of credential material", async () => {
    for (const version of await readdir(fixtures)) {
      for (const file of await readdir(path.join(fixtures, version))) {
        const content = await readFile(path.join(fixtures, version, file), "utf8");
        for (const pattern of SECRET_PATTERNS) expect(content, `${version}/${file} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("detects a credential if one is planted, so the scanner is not vacuous", () => {
    const planted = ['{"api_key":"abc"}', "sk_live_ABCDEFGH12345678", "postgres://owner:hunter2@db.example/app"];
    for (const sample of planted) expect(SECRET_PATTERNS.some((pattern) => pattern.test(sample))).toBe(true);
  });

  it("records only catalog service identifiers that the fixtures actually contain", async () => {
    for (const [provider, services] of Object.entries(CATALOG_SERVICES)) {
      const catalog = JSON.parse(await readFile(path.join(fixtures, SUPPORTED_TOOLCHAIN.pluginVersion, `catalog-${provider}.json`), "utf8")) as { version: string; data: { services: Array<{ service_id: string; kind: string; scope: string; pricing: { type: string } }>; provider: { existing_resource_linking: string } } };
      expect(catalog.version).toBe(SUPPORTED_TOOLCHAIN.envelopeVersion);
      expect(Object.fromEntries(catalog.data.services.map((service) => [service.service_id, { kind: service.kind, scope: service.scope, pricing: service.pricing.type }]))).toEqual(services);
      expect(catalog.data.provider.existing_resource_linking).toBe("unsupported");
    }
    for (const row of PROJECTS_CAPABILITIES) expect(Object.keys(CATALOG_SERVICES[row.provider] ?? {}), row.provider).toContain(row.service);
  });

  it("describes every effect of every command a capability uses", () => {
    for (const row of PROJECTS_CAPABILITIES) expect(() => effectsOf(row.commands)).not.toThrow();
    expect(() => effectsOf(["share"])).toThrow(/no recorded effect inventory/u);
    expect(effectsOf(["rotate"])).toContain("local_plaintext_credentials");
    expect(effectsOf(["add"])).toEqual(expect.arrayContaining(["remote_resource_create", "local_plaintext_credentials", "may_charge"]));
    expect(isRemoteReadOnly("catalog")).toBe(true);
    for (const command of ["add", "rotate", "remove", "link", "init", "env pull", "upgrade"]) expect(isRemoteReadOnly(command), command).toBe(false);
    expect(Object.keys(COMMAND_EFFECTS)).not.toContain("billing add");
  });

  it("allows no mutation without hosted evidence", () => {
    for (const row of PROJECTS_CAPABILITIES.filter((candidate) => MUTATING.has(candidate.operation))) {
      expect(resolveCapability(row, SUPPORTED_TOOLCHAIN, now).allowed, `${row.provider}/${row.service} ${row.operation}`).toBe(false);
    }
    const create = PROJECTS_CAPABILITIES.find((row) => row.operation === "create")!;
    for (const evidence of ["documented", "locally_tested", "unknown"] as const) {
      expect(resolveCapability({ ...create, evidence, unknowns: [] }, SUPPORTED_TOOLCHAIN, now).allowed, evidence).toBe(false);
    }
    const discover = PROJECTS_CAPABILITIES.find((row) => row.operation === "discover")!;
    expect(resolveCapability(discover, SUPPORTED_TOOLCHAIN, now)).toMatchObject({ allowed: true, evidence: "locally_tested" });
  });

  it("treats rotation as blocked while invalidation and response-loss behavior are unknown", () => {
    const rotate = PROJECTS_CAPABILITIES.find((row) => row.provider === "neon" && row.operation === "rotate")!;
    const hosted = resolveCapability({ ...rotate, evidence: "hosted_verified" }, SUPPORTED_TOOLCHAIN, now);
    expect(hosted.allowed).toBe(false);
    expect(hosted.reasons).toEqual(expect.arrayContaining(["unknown: re-retrieval after response loss", "unknown: invalidation timing"]));
    expect(resolveCapability({ ...rotate, evidence: "hosted_verified", unknowns: [] }, SUPPORTED_TOOLCHAIN, now).allowed).toBe(true);
  });

  it("invalidates evidence when the plugin version, executable hash, or schema changes (AR-14)", () => {
    const qualified = { ...PROJECTS_CAPABILITIES.find((row) => row.operation === "create")!, evidence: "hosted_verified" as const, unknowns: [] };
    expect(resolveCapability(qualified, SUPPORTED_TOOLCHAIN, now).allowed).toBe(true);
    for (const drift of [{ pluginVersion: "0.46.0" }, { pluginSha256: "0".repeat(64) }, { envelopeVersion: "0.2" }]) {
      const resolved = resolveCapability(qualified, { ...SUPPORTED_TOOLCHAIN, ...drift }, now);
      expect(resolved).toMatchObject({ evidence: "unknown", allowed: false });
    }
    expect(resolveCapability(qualified, undefined, now)).toMatchObject({ evidence: "unknown", allowed: false });
  });

  it("expires stale evidence and rejects rows without an observation time", () => {
    const qualified = { ...PROJECTS_CAPABILITIES.find((row) => row.operation === "create")!, evidence: "hosted_verified" as const, unknowns: [] };
    expect(resolveCapability(qualified, SUPPORTED_TOOLCHAIN, new Date("2026-12-01T00:00:00.000Z"))).toMatchObject({ evidence: "unknown", allowed: false });
    expect(resolveCapability({ ...qualified, observedAt: "yesterday-ish" }, SUPPORTED_TOOLCHAIN, now)).toMatchObject({ evidence: "unknown", allowed: false });
  });

  it("keeps adoption unsupported for providers that report no existing-resource linking", () => {
    for (const row of PROJECTS_CAPABILITIES.filter((candidate) => candidate.operation === "adopt")) {
      const resolved = resolveCapability(row, SUPPORTED_TOOLCHAIN, now);
      expect(resolved).toMatchObject({ evidence: "unsupported", allowed: false });
      expect(resolved.reasons.join(" ")).toMatch(/unsupported through Projects/u);
    }
  });
});
