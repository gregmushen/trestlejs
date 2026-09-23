import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEvent, defineEventCatalog, EventCatalogError } from "./catalog.js";

const internal = z.object({ contractId: z.string(), signedAt: z.iso.datetime(), signerCount: z.number().int().nonnegative(), internalToken: z.string() });
const publicPayload = z.object({ contractId: z.string(), signedAt: z.iso.datetime(), signerCount: z.number().int().nonnegative() }).strict();
const validPayload = { contractId: "contract-1", signedAt: "2026-09-22T18:30:00.000Z", signerCount: 2, internalToken: "secret-internal-value" };

function signedEvent() {
  return defineEvent({
    name: "contract.signed", schemaVersion: 2, description: "A contract was signed.",
    resource: { type: "contract", id: (payload) => payload.contractId },
    payload: internal, sensitivity: "confidential",
    webhook: {
      type: "contract.signed", version: 1, description: "Sent when a contract is fully signed.",
      payload: publicPayload,
      project: (payload) => ({ contractId: payload.contractId, signedAt: payload.signedAt, signerCount: payload.signerCount }),
      sensitivity: { classification: "customer", retentionClass: "standard" },
      entitlement: "webhooks.events.contracts",
      examples: [{ contractId: "contract_example", signedAt: "2026-09-22T18:30:00.000Z", signerCount: 2 }],
      fixtures: [{ internal: validPayload, public: { contractId: "contract-1", signedAt: validPayload.signedAt, signerCount: 2 } }],
    },
  });
}

describe("application-owned public event catalog", () => {
  it("validates private payloads and exposes only explicit public projections", () => {
    const privateOnly = defineEvent({ name: "contract.reviewed", schemaVersion: 1, description: "A contract was reviewed.", resource: { type: "contract", id: (payload: { contractId: string }) => payload.contractId }, payload: z.object({ contractId: z.string() }), sensitivity: "internal" });
    const catalog = defineEventCatalog([signedEvent(), privateOnly]);
    expect(catalog.parse("contract.signed", 2, validPayload)).toEqual(validPayload);
    expect(catalog.resource("contract.signed", 2, validPayload)).toEqual({ type: "contract", id: "contract-1" });
    expect(catalog.project("contract.signed", 2, validPayload)).toEqual({
      type: "contract.signed", version: 1, resource: { type: "contract", id: "contract-1" }, data: { contractId: "contract-1", signedAt: validPayload.signedAt, signerCount: 2 },
    });
    expect(catalog.project("contract.reviewed", 1, { contractId: "contract-1" })).toBeNull();
    const metadata = catalog.publicEvents();
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({ type: "contract.signed", version: 1, entitlement: "webhooks.events.contracts" });
    expect(JSON.stringify(metadata)).not.toContain("internalToken");
    expect(JSON.stringify(metadata)).not.toContain("secret-internal-value");
    expect(JSON.stringify(metadata)).not.toContain("project");
  });

  it("rejects invalid internal and public payloads without exposing sensitive values", () => {
    const catalog = defineEventCatalog([signedEvent()]);
    expect(() => catalog.parse("contract.signed", 2, { ...validPayload, signerCount: -1 })).toThrow("Internal event payload fails its schema");
    expect(() => catalog.project("contract.signed", 2, { ...validPayload, signerCount: -1 })).toThrow("Internal event payload fails its schema");
    const badProjection = defineEvent({ name: "contract.failed", schemaVersion: 1, description: "Failed projection test.", resource: { type: "contract", id: (payload: { contractId: string }) => payload.contractId }, payload: z.object({ contractId: z.string() }), sensitivity: "internal", webhook: { type: "contract.failed", version: 1, description: "Failed public projection.", payload: z.object({ contractId: z.string() }), project: (payload) => payload.contractId === "fixture" ? { contractId: "fixture" } : { contractId: 123, token: "secret-internal-value" }, sensitivity: { classification: "customer", retentionClass: "short" }, examples: [{ contractId: "example" }], fixtures: [{ internal: { contractId: "fixture" }, public: { contractId: "fixture" } }] } });
    expect(() => defineEventCatalog([badProjection]).project("contract.failed", 1, { contractId: "c" })).toThrow("Public projection failed validation");
    try { defineEventCatalog([badProjection]).project("contract.failed", 1, { contractId: "c" }); }
    catch (error) { expect(String(error)).not.toContain("secret-internal-value"); }
  });

  it("rejects duplicate identities, reserved names, invalid examples, and missing classifications", () => {
    const event = signedEvent();
    expect(() => defineEventCatalog([event, event])).toThrow("Duplicate internal event");
    const another = defineEvent({ name: "contract.completed", schemaVersion: 1, description: "Completed.", resource: { type: "contract", id: () => "c" }, payload: z.object({}), sensitivity: "internal", webhook: { type: "contract.signed", version: 1, description: "Duplicate public type.", payload: z.object({}), project: () => ({}), sensitivity: { classification: "customer", retentionClass: "standard" }, examples: [{}], fixtures: [{ internal: {}, public: {} }] } });
    expect(() => defineEventCatalog([event, another])).toThrow("Duplicate public event");
    expect(() => defineEvent({ name: "webhook.test", schemaVersion: 1, description: "Reserved.", resource: { type: "contract", id: () => "c" }, payload: z.object({}), sensitivity: "internal" })).toThrow("non-reserved");
    expect(() => defineEvent({ name: "contract.Invalid", schemaVersion: 1, description: "Invalid.", resource: { type: "contract", id: () => "c" }, payload: z.object({}), sensitivity: "internal" })).toThrow("lowercase dotted");
    expect(() => defineEvent({ name: "contract.signed", schemaVersion: 0, description: "Bad version.", resource: { type: "contract", id: () => "c" }, payload: z.object({}), sensitivity: "internal" })).toThrow("positive integer");
    expect(() => defineEvent({ name: "contract.signed", schemaVersion: 1, description: "Valid.", resource: { type: "contract", id: () => "c" }, payload: z.object({}), sensitivity: "internal", webhook: { type: "contract.public", version: 1, description: "Public.", payload: z.object({ value: z.string() }), project: () => ({ value: "okay" }), sensitivity: { classification: "customer", retentionClass: "standard" }, examples: [{ value: 4 }], fixtures: [{ internal: {}, public: { value: "okay" } }] } })).toThrow("example fails its schema");
    expect(() => defineEvent({ name: "contract.signed", schemaVersion: 1, description: "Valid.", resource: { type: "contract", id: () => "c" }, payload: z.object({}), sensitivity: "internal", webhook: { type: "contract.public", version: 1, description: "Public.", payload: z.object({ value: z.string() }), project: () => ({ value: "actual" }), sensitivity: { classification: "customer", retentionClass: "standard" }, examples: [{ value: "example" }], fixtures: [{ internal: {}, public: { value: "different" } }] } })).toThrow("Projection fixture does not match");
  });

  it("allows a private schema upgrade without changing the public version", () => {
    const version2 = signedEvent();
    const version3 = defineEvent({
      name: "contract.signed", schemaVersion: 3, description: "A contract was signed.",
      resource: { type: "contract", id: (payload) => payload.contractId },
      payload: internal.extend({ workflowVersion: z.number().int() }), sensitivity: "confidential",
      webhook: {
        type: "contract.signed", version: 1, description: "Sent when a contract is fully signed.",
        payload: publicPayload,
        project: (payload) => ({ contractId: payload.contractId, signedAt: payload.signedAt, signerCount: payload.signerCount }),
        sensitivity: { classification: "customer", retentionClass: "standard" }, entitlement: "webhooks.events.contracts",
        examples: [{ contractId: "contract_example", signedAt: "2026-09-22T18:30:00.000Z", signerCount: 2 }],
        fixtures: [{ internal: { ...validPayload, workflowVersion: 2 }, public: { contractId: "contract-1", signedAt: validPayload.signedAt, signerCount: 2 } }],
      },
    });
    const catalog = defineEventCatalog([version2, version3]);
    expect(catalog.publicEvents()).toHaveLength(1);
    expect(catalog.project("contract.signed", 3, { ...validPayload, workflowVersion: 2 })?.version).toBe(1);
  });

  it("does not expose the definition or projector through catalog metadata copies", () => {
    const catalog = defineEventCatalog([signedEvent()]);
    const first = catalog.publicEvents();
    (first[0]!.examples as unknown[]).push("modified");
    expect(catalog.publicEvents()[0]!.examples).toHaveLength(1);
    expect(() => catalog.parse("contract.signed", 1, validPayload)).toThrow("not registered");
    expect(EventCatalogError.name).toBe("EventCatalogError");
  });
});
