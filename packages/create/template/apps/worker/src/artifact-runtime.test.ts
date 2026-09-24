import { describe, expect, it } from "vitest";
import { artifactRuntimeReady, artifactSigner, artifactStore, publicArtifactUrl } from "./artifact-runtime.js";

const base = { DATABASE_URL: "postgres://unused", BETTER_AUTH_SECRET: "local-auth-secret-at-least-32-characters" };

describe("artifact runtime configuration", () => {
  it("uses the direct Worker origin for a Pages-forwarded signed download", () => {
    expect(publicArtifactUrl("/artifacts/artifact-1?signature=abc", { ...base, BETTER_AUTH_URL: "https://api.example.test" }, "https://app.example.test/api/artifacts/artifact-1/access"))
      .toBe("https://api.example.test/artifacts/artifact-1?signature=abc");
  });

  it("uses a local store and domain-separated signed access in development", async () => {
    const environment = { ...base, APP_ENV: "local" as const };
    const store = artifactStore(environment, "org-a");
    const id = crypto.randomUUID();
    await store.put({ id, organizationId: "org-a", key: id, contentType: "text/plain", body: new TextEncoder().encode("private") });
    expect(await store.get("org-b", id)).toBeNull();
    const access = await artifactSigner(environment).create("org-a", id);
    const url = new URL(access.url, "http://localhost");
    expect(await artifactSigner(environment).verify({ organizationId: "org-a", artifactId: id, expiresAt: Number(url.searchParams.get("expires")), signature: url.searchParams.get("signature")! })).toBe(true);
    expect(await artifactSigner(environment).verify({ organizationId: "org-b", artifactId: id, expiresAt: Number(url.searchParams.get("expires")), signature: url.searchParams.get("signature")! })).toBe(false);
    await store.delete("org-a", id);
  });

  it("fails closed when remote R2 or its independent signing key is missing", () => {
    const environment = { ...base, APP_ENV: "preview" as const };
    expect(artifactRuntimeReady(environment)).toBe(false);
    expect(() => artifactStore(environment, "org-a")).toThrow("R2 artifact binding");
    expect(() => artifactSigner(environment)).toThrow("ARTIFACT_SIGNING_SECRET");
    expect(artifactRuntimeReady({ ...environment, TRESTLE_ARTIFACTS: { put: async () => undefined, get: async () => null, delete: async () => undefined } })).toBe(false);
    expect(artifactRuntimeReady({ ...environment, ARTIFACT_SIGNING_SECRET: "short", TRESTLE_ARTIFACTS: { put: async () => undefined, get: async () => null, delete: async () => undefined } })).toBe(false);
  });

  it("does not silently ignore a retention policy without R2", () => {
    expect(() => artifactStore({ ...base, APP_ENV: "local", ARTIFACT_READY_RETENTION_DAYS: "7" }, "org-a"))
      .toThrow("requires the R2 binding");
  });
});
