import { describe, expect, it } from "vitest";
import { CloudflareR2ArtifactStore, InMemoryArtifactMetadataRepository, LocalArtifactStore, createArtifactSigner } from "./index.js";

describe("tenant-owned artifact storage", () => {
  it("stores, copies, and deletes local artifacts within one tenant", async () => { const store = new LocalArtifactStore(); const body = new Uint8Array([1, 2, 3]); const metadata = await store.put({ id: "a", organizationId: "org-a", key: "report.pdf", contentType: "application/pdf", body }); body[0] = 9; expect(metadata).toMatchObject({ organizationId: "org-a", size: 3 }); expect((await store.get("org-a", "a"))?.body[0]).toBe(1); expect(await store.delete("org-a", "a")).toBe(true); expect(await store.get("org-a", "a")).toBeNull(); });
  it("fails closed for cross-tenant reads, deletes, and identifier replacement", async () => { const store = new LocalArtifactStore(); await store.put({ id: "a", organizationId: "org-a", key: "a.txt", contentType: "text/plain", body: new Uint8Array() }); expect(await store.get("org-b", "a")).toBeNull(); expect(await store.delete("org-b", "a")).toBe(false); await expect(store.put({ id: "a", organizationId: "org-b", key: "b.txt", contentType: "text/plain", body: new Uint8Array() })).rejects.toThrow("another organization"); });
  it("prefixes R2 keys with tenant ownership and preserves metadata", async () => { const calls: unknown[] = []; const bytes = new Uint8Array([4, 5]); const bucket = { put: async (...args: unknown[]) => { calls.push(args); }, get: async () => ({ size: 2, arrayBuffer: async () => bytes.buffer }), delete: async (key: string) => { calls.push(key); } }; const store = new CloudflareR2ArtifactStore(bucket, new InMemoryArtifactMetadataRepository()); await store.put({ id: "a", organizationId: "org-a", key: "x.bin", contentType: "application/octet-stream", body: bytes }); expect(calls[0]).toEqual(["org-a/x.bin", bytes, expect.objectContaining({ customMetadata: { artifactId: "a", organizationId: "org-a" } })]); expect((await store.get("org-a", "a"))?.body).toEqual(bytes); expect(await store.get("org-b", "a")).toBeNull(); });
  it("signs artifact access with tenant scope, expiry, and a cryptographic MAC", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const signer = createArtifactSigner("a-32-byte-minimum-secret-for-tests", () => now);
    const access = await signer.create("org-a", "artifact-a", 60);
    const params = new URL(`http://localhost${access.url}`).searchParams;
    const input = { organizationId: "org-a", artifactId: "artifact-a", expiresAt: Number(params.get("expires")), signature: params.get("signature")! };
    expect(input.signature).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await signer.verify(input)).toBe(true);
    expect(await signer.verify({ ...input, organizationId: "org-b" })).toBe(false);
    expect(await signer.verify({ ...input, artifactId: "artifact-b" })).toBe(false);
    expect(await signer.verify({ ...input, expiresAt: input.expiresAt + 60_000 })).toBe(false);
    expect(await signer.verify({ ...input, signature: `${input.signature.slice(0, -1)}!` })).toBe(false);
    expect(await createArtifactSigner("another-32-byte-secret-for-tests!!", () => now).verify(input)).toBe(false);
    now = new Date("2026-01-01T00:02:00Z");
    expect(await signer.verify(input)).toBe(false);
  });

  it("rejects weak secrets, ambiguous identities, and unbounded link lifetimes", async () => {
    expect(() => createArtifactSigner("short")).toThrow("32 bytes");
    const signer = createArtifactSigner("a-32-byte-minimum-secret-for-tests");
    await expect(signer.create("", "artifact-a")).rejects.toThrow("owner");
    await expect(signer.create("org-a", "artifact-a", 3601)).rejects.toThrow("TTL");
    expect(await signer.verify({ organizationId: "org-a", artifactId: "artifact-a", expiresAt: Number.NaN, signature: "x".repeat(43) })).toBe(false);
  });
});
