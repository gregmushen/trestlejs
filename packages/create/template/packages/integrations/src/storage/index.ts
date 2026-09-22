export type ArtifactMetadata = { id: string; organizationId: string; key: string; contentType: string; size: number; createdAt: Date };
export type Artifact = ArtifactMetadata & { body: Uint8Array };
export type SignedArtifactAccess = { url: string; expiresAt: Date };
export interface ArtifactStore {
  put(input: { id: string; organizationId: string; key: string; contentType: string; body: Uint8Array }): Promise<ArtifactMetadata>;
  get(organizationId: string, id: string): Promise<Artifact | null>;
  delete(organizationId: string, id: string): Promise<boolean>;
}
export interface ArtifactMetadataRepository {
  put(metadata: ArtifactMetadata): Promise<ArtifactMetadata>;
  get(organizationId: string, id: string): Promise<ArtifactMetadata | null>;
  remove(organizationId: string, id: string): Promise<boolean>;
}

export class InMemoryArtifactMetadataRepository implements ArtifactMetadataRepository {
  private readonly records = new Map<string, ArtifactMetadata>();
  async put(metadata: ArtifactMetadata): Promise<ArtifactMetadata> { const existing = this.records.get(metadata.id); if (existing && existing.organizationId !== metadata.organizationId) throw new Error("artifact identifier belongs to another organization"); this.records.set(metadata.id, metadata); return metadata; }
  async get(organizationId: string, id: string): Promise<ArtifactMetadata | null> { const metadata = this.records.get(id); return metadata?.organizationId === organizationId ? { ...metadata } : null; }
  async remove(organizationId: string, id: string): Promise<boolean> { const metadata = this.records.get(id); return metadata?.organizationId === organizationId ? this.records.delete(id) : false; }
}

export function createArtifactSigner(secret: string, now: () => Date = () => new Date()) {
  if (new TextEncoder().encode(secret).byteLength < 32) throw new Error("artifact signing secret must be at least 32 bytes");
  const encode = (value: string) => encodeURIComponent(value);
  const key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const payload = (organizationId: string, artifactId: string, expiresAt: number) =>
    new TextEncoder().encode(["trestle-artifact-v1", organizationId, artifactId, String(expiresAt)].join("\0"));
  return {
    async create(organizationId: string, artifactId: string, ttlSeconds = 300): Promise<SignedArtifactAccess> {
      if (!organizationId || !artifactId) throw new Error("artifact owner and identifier are required");
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error("artifact access TTL must be between 1 and 3600 seconds");
      const expiresAt = new Date(now().getTime() + ttlSeconds * 1_000);
      const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", await key, payload(organizationId, artifactId, expiresAt.getTime())));
      const signature = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
      return { url: `/artifacts/${encode(artifactId)}?organization=${encode(organizationId)}&expires=${expiresAt.getTime()}&signature=${signature}`, expiresAt };
    },
    async verify(input: { organizationId: string; artifactId: string; expiresAt: number; signature: string }): Promise<boolean> {
      if (!input.organizationId || !input.artifactId || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now().getTime() || !/^[A-Za-z0-9_-]{43}$/u.test(input.signature)) return false;
      try {
        const base64 = input.signature.replaceAll("-", "+").replaceAll("_", "/") + "=";
        const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        return await crypto.subtle.verify("HMAC", await key, bytes, payload(input.organizationId, input.artifactId, input.expiresAt));
      } catch { return false; }
    },
  };
}

export class LocalArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, Artifact>();
  async put(input: { id: string; organizationId: string; key: string; contentType: string; body: Uint8Array }): Promise<ArtifactMetadata> {
    if (!input.organizationId || !input.id || !input.key || !input.contentType) throw new Error("artifact identity, owner, key, and content type are required");
    const existing = this.artifacts.get(input.id);
    if (existing && existing.organizationId !== input.organizationId) throw new Error("artifact identifier belongs to another organization");
    const artifact = { ...input, body: input.body.slice(), size: input.body.byteLength, createdAt: existing?.createdAt ?? new Date() };
    this.artifacts.set(input.id, artifact); return this.metadata(artifact);
  }
  async get(organizationId: string, id: string): Promise<Artifact | null> { const artifact = this.artifacts.get(id); return artifact?.organizationId === organizationId ? { ...artifact, body: artifact.body.slice() } : null; }
  async delete(organizationId: string, id: string): Promise<boolean> { const artifact = this.artifacts.get(id); if (!artifact || artifact.organizationId !== organizationId) return false; return this.artifacts.delete(id); }
  private metadata({ body: _body, ...metadata }: Artifact): ArtifactMetadata { return metadata; }
}

export type R2ObjectBody = { arrayBuffer(): Promise<ArrayBuffer>; size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> };
export type R2BucketBinding = { put(key: string, body: Uint8Array, options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }): Promise<unknown>; get(key: string): Promise<R2ObjectBody | null>; delete(key: string): Promise<void> };

export class CloudflareR2ArtifactStore implements ArtifactStore {
  constructor(private readonly bucket: R2BucketBinding, private readonly metadata: ArtifactMetadataRepository = new InMemoryArtifactMetadataRepository()) {}
  async put(input: { id: string; organizationId: string; key: string; contentType: string; body: Uint8Array }): Promise<ArtifactMetadata> {
    const storageKey = `${input.organizationId}/${input.key}`;
    await this.bucket.put(storageKey, input.body, { httpMetadata: { contentType: input.contentType }, customMetadata: { artifactId: input.id, organizationId: input.organizationId } });
    return await this.metadata.put({ id: input.id, organizationId: input.organizationId, key: storageKey, contentType: input.contentType, size: input.body.byteLength, createdAt: new Date() });
  }
  async get(organizationId: string, id: string): Promise<Artifact | null> { const metadata = await this.metadata.get(organizationId, id); if (!metadata) return null; const object = await this.bucket.get(metadata.key); return object ? { ...metadata, body: new Uint8Array(await object.arrayBuffer()) } : null; }
  async delete(organizationId: string, id: string): Promise<boolean> { const metadata = await this.metadata.get(organizationId, id); if (!metadata) return false; await this.bucket.delete(metadata.key); return await this.metadata.remove(organizationId, id); }
}
