export type ArtifactMetadata = { id: string; organizationId: string; key: string; contentType: string; size: number; createdAt: Date };
export type Artifact = ArtifactMetadata & { body: Uint8Array };
export type SignedArtifactAccess = { url: string; expiresAt: Date };
export interface ArtifactStore {
  put(input: { id: string; organizationId: string; key: string; contentType: string; body: Uint8Array }): Promise<ArtifactMetadata>;
  get(organizationId: string, id: string): Promise<Artifact | null>;
  delete(organizationId: string, id: string): Promise<boolean>;
}

export function createArtifactSigner(secret: string, now: () => Date = () => new Date()) {
  if (!secret) throw new Error("artifact signing secret is required");
  const encode = (value: string) => encodeURIComponent(value);
  const sign = (value: string) => { let hash = 0; for (const char of `${secret}:${value}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return hash.toString(16).padStart(8, "0"); };
  return {
    create(organizationId: string, artifactId: string, ttlSeconds = 300): SignedArtifactAccess { const expiresAt = new Date(now().getTime() + ttlSeconds * 1_000); const value = `${organizationId}:${artifactId}:${expiresAt.getTime()}`; return { url: `/artifacts/${encode(artifactId)}?organization=${encode(organizationId)}&expires=${expiresAt.getTime()}&signature=${sign(value)}`, expiresAt }; },
    verify(input: { organizationId: string; artifactId: string; expiresAt: number; signature: string }): boolean { if (input.expiresAt <= now().getTime()) return false; return sign(`${input.organizationId}:${input.artifactId}:${input.expiresAt}`) === input.signature; },
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
  constructor(private readonly bucket: R2BucketBinding, private readonly metadataById: Map<string, ArtifactMetadata> = new Map()) {}
  async put(input: { id: string; organizationId: string; key: string; contentType: string; body: Uint8Array }): Promise<ArtifactMetadata> {
    const storageKey = `${input.organizationId}/${input.key}`;
    await this.bucket.put(storageKey, input.body, { httpMetadata: { contentType: input.contentType }, customMetadata: { artifactId: input.id, organizationId: input.organizationId } });
    const metadata = { id: input.id, organizationId: input.organizationId, key: storageKey, contentType: input.contentType, size: input.body.byteLength, createdAt: new Date() };
    this.metadataById.set(input.id, metadata); return metadata;
  }
  async get(organizationId: string, id: string): Promise<Artifact | null> { const metadata = this.metadataById.get(id); if (!metadata || metadata.organizationId !== organizationId) return null; const object = await this.bucket.get(metadata.key); return object ? { ...metadata, body: new Uint8Array(await object.arrayBuffer()) } : null; }
  async delete(organizationId: string, id: string): Promise<boolean> { const metadata = this.metadataById.get(id); if (!metadata || metadata.organizationId !== organizationId) return false; await this.bucket.delete(metadata.key); this.metadataById.delete(id); return true; }
}
