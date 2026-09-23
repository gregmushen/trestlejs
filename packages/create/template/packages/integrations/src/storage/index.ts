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
  complete(organizationId: string, id: string, key: string): Promise<boolean>;
  get(organizationId: string, id: string): Promise<ArtifactMetadata | null>;
  /** Make a ready object inaccessible before attempting an external delete. */
  beginDeletion(organizationId: string, id: string): Promise<ArtifactMetadata | null>;
  remove(organizationId: string, id: string): Promise<boolean>;
  discard(organizationId: string, id: string, key: string): Promise<boolean>;
  retire(organizationId: string, id: string, key: string): Promise<boolean>;
  listIncomplete(organizationId: string, before: Date, limit: number): Promise<ArtifactMetadata[]>;
  claimIncomplete(organizationId: string, id: string, key: string, before: Date): Promise<boolean>;
  listExpiredReady(organizationId: string, before: Date, limit: number): Promise<ArtifactMetadata[]>;
  claimExpiredReady(organizationId: string, id: string, key: string, before: Date): Promise<boolean>;
}

function validateRecovery(before: Date, limit: number): void {
  if (!Number.isFinite(before.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid artifact recovery parameters");
}

export class InMemoryArtifactMetadataRepository implements ArtifactMetadataRepository {
  private readonly records = new Map<string, ArtifactMetadata>();
  private readonly reservedIds = new Set<string>();
  private readonly pendingIds = new Set<string>();
  private readonly cleaningIds = new Set<string>();
  async put(metadata: ArtifactMetadata): Promise<ArtifactMetadata> { if (this.reservedIds.has(metadata.id)) throw new Error("artifact identifier is unavailable"); this.records.set(metadata.id, metadata); this.reservedIds.add(metadata.id); this.pendingIds.add(metadata.id); return metadata; }
  async complete(organizationId: string, id: string, key: string): Promise<boolean> { const metadata = this.records.get(id); if (metadata?.organizationId !== organizationId || metadata.key !== key || !this.pendingIds.has(id)) return false; this.pendingIds.delete(id); return true; }
  async get(organizationId: string, id: string): Promise<ArtifactMetadata | null> { const metadata = this.records.get(id); return metadata?.organizationId === organizationId && !this.pendingIds.has(id) && !this.cleaningIds.has(id) ? { ...metadata } : null; }
  async beginDeletion(organizationId: string, id: string): Promise<ArtifactMetadata | null> { const metadata = this.records.get(id); if (metadata?.organizationId !== organizationId || this.pendingIds.has(id)) return null; this.cleaningIds.add(id); return { ...metadata }; }
  async remove(organizationId: string, id: string): Promise<boolean> { const metadata = this.records.get(id); return metadata?.organizationId === organizationId && !this.pendingIds.has(id) && !this.cleaningIds.has(id) ? this.records.delete(id) : false; }
  async discard(organizationId: string, id: string, key: string): Promise<boolean> { const metadata = this.records.get(id); if (metadata?.organizationId !== organizationId || metadata.key !== key || !this.pendingIds.has(id)) return false; this.pendingIds.delete(id); this.reservedIds.delete(id); return this.records.delete(id); }
  async retire(organizationId: string, id: string, key: string): Promise<boolean> { const metadata = this.records.get(id); if (metadata?.organizationId !== organizationId || metadata.key !== key) return false; this.pendingIds.delete(id); this.cleaningIds.delete(id); return this.records.delete(id); }
  async listIncomplete(organizationId: string, before: Date, limit: number): Promise<ArtifactMetadata[]> {
    validateRecovery(before, limit);
    return [...this.records.values()].filter((metadata) => metadata.organizationId === organizationId && metadata.createdAt < before && (this.pendingIds.has(metadata.id) || this.cleaningIds.has(metadata.id)))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)).slice(0, limit).map((metadata) => ({ ...metadata }));
  }
  async claimIncomplete(organizationId: string, id: string, key: string, before: Date): Promise<boolean> {
    if (!Number.isFinite(before.getTime())) throw new Error("Invalid artifact recovery cutoff");
    const metadata = this.records.get(id);
    if (metadata?.organizationId !== organizationId || metadata.key !== key || metadata.createdAt >= before || (!this.pendingIds.has(id) && !this.cleaningIds.has(id))) return false;
    this.pendingIds.delete(id); this.cleaningIds.add(id); return true;
  }
  async listExpiredReady(organizationId: string, before: Date, limit: number): Promise<ArtifactMetadata[]> {
    validateRecovery(before, limit);
    return [...this.records.values()].filter((metadata) => metadata.organizationId === organizationId && metadata.createdAt < before && !this.pendingIds.has(metadata.id) && !this.cleaningIds.has(metadata.id))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)).slice(0, limit).map((metadata) => ({ ...metadata }));
  }
  async claimExpiredReady(organizationId: string, id: string, key: string, before: Date): Promise<boolean> {
    if (!Number.isFinite(before.getTime())) throw new Error("Invalid artifact retention cutoff");
    const metadata = this.records.get(id);
    if (metadata?.organizationId !== organizationId || metadata.key !== key || metadata.createdAt >= before || this.pendingIds.has(id) || this.cleaningIds.has(id)) return false;
    this.cleaningIds.add(id); return true;
  }
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
  private readonly reservedIds = new Set<string>();
  async put(input: { id: string; organizationId: string; key: string; contentType: string; body: Uint8Array }): Promise<ArtifactMetadata> {
    if (!input.organizationId || !input.id || !input.key || !input.contentType) throw new Error("artifact identity, owner, key, and content type are required");
    if (this.reservedIds.has(input.id)) throw new Error("artifact identifier is unavailable");
    const artifact = { ...input, body: input.body.slice(), size: input.body.byteLength, createdAt: new Date() };
    this.artifacts.set(input.id, artifact); this.reservedIds.add(input.id); return this.metadata(artifact);
  }
  async get(organizationId: string, id: string): Promise<Artifact | null> { const artifact = this.artifacts.get(id); return artifact?.organizationId === organizationId ? { ...artifact, body: artifact.body.slice() } : null; }
  async delete(organizationId: string, id: string): Promise<boolean> { const artifact = this.artifacts.get(id); if (!artifact || artifact.organizationId !== organizationId) return false; return this.artifacts.delete(id); }
  private metadata({ body: _body, ...metadata }: Artifact): ArtifactMetadata { return metadata; }
}

export type R2ObjectBody = { arrayBuffer(): Promise<ArrayBuffer>; size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> };
export type R2ObjectMetadata = { size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> };
export type R2ListedObject = R2ObjectMetadata & { key: string; uploaded: Date };
export type R2ListPage = { objects: R2ListedObject[]; truncated: boolean; cursor?: string };
export type R2BucketBinding = { put(key: string, body: Uint8Array, options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }): Promise<unknown>; get(key: string): Promise<R2ObjectBody | null>; head?(key: string): Promise<R2ObjectMetadata | null>; list?(options: { prefix: string; limit: number; cursor?: string }): Promise<R2ListPage>; delete(key: string): Promise<void> };

export class CloudflareR2ArtifactStore implements ArtifactStore {
  constructor(private readonly bucket: R2BucketBinding, private readonly metadata: ArtifactMetadataRepository, private readonly retention?: { maxAgeDays: number; now: () => Date }) {}
  async put(input: { id: string; organizationId: string; key: string; contentType: string; body: Uint8Array }): Promise<ArtifactMetadata> {
    if (!input.organizationId || !input.id || !input.key || !input.contentType) throw new Error("artifact identity, owner, key, and content type are required");
    const storageKey = `${input.organizationId}/${input.id}/${crypto.randomUUID()}/${input.key}`;
    const metadata = await this.metadata.put({ id: input.id, organizationId: input.organizationId, key: storageKey, contentType: input.contentType, size: input.body.byteLength, createdAt: new Date() });
    try {
      await this.bucket.put(storageKey, input.body, { httpMetadata: { contentType: input.contentType }, customMetadata: { artifactId: input.id, organizationId: input.organizationId } });
    } catch (error) {
      // A failed response may follow a committed R2 write. Keep the metadata
      // reservation if physical cleanup cannot be confirmed.
      try { await this.bucket.delete(storageKey); }
      catch { throw new Error("Artifact upload failed and object cleanup could not be verified"); }
      await this.metadata.discard(input.organizationId, input.id, storageKey);
      throw error;
    }
    try {
      if (!await this.metadata.complete(input.organizationId, input.id, storageKey)) throw new Error("Artifact metadata reservation was not available");
      return metadata;
    } catch {
      try { await this.bucket.delete(storageKey); }
      catch { throw new Error("Artifact upload could not be finalized and object cleanup could not be verified"); }
      await this.metadata.retire(input.organizationId, input.id, storageKey);
      throw new Error("Artifact upload could not be finalized");
    }
  }
  async get(organizationId: string, id: string): Promise<Artifact | null> { const metadata = await this.metadata.get(organizationId, id); if (!metadata || (this.retention && metadata.createdAt.getTime() < this.retention.now().getTime() - this.retention.maxAgeDays * 86_400_000)) return null; const object = await this.bucket.get(metadata.key); return object ? { ...metadata, body: new Uint8Array(await object.arrayBuffer()) } : null; }
  async delete(organizationId: string, id: string): Promise<boolean> {
    const metadata = await this.metadata.beginDeletion(organizationId, id);
    if (!metadata) return false;
    // A failed external delete leaves a durable, inaccessible "cleaning" row.
    // The scheduled recovery sweep retries it after the bounded grace period.
    await this.bucket.delete(metadata.key);
    await this.metadata.retire(organizationId, id, metadata.key);
    return true;
  }
  async recoverIncomplete(organizationId: string, before: Date, limit = 25): Promise<{ claimed: number; retired: number; failed: number }> {
    validateRecovery(before, limit);
    if (!organizationId) throw new Error("Artifact owner is required for recovery");
    const candidates = await this.metadata.listIncomplete(organizationId, before, limit);
    let claimed = 0; let retired = 0; let failed = 0;
    for (const artifact of candidates) {
      if (!await this.metadata.claimIncomplete(organizationId, artifact.id, artifact.key, before)) continue;
      claimed += 1;
      try { await this.bucket.delete(artifact.key); }
      catch { failed += 1; continue; }
      try { if (await this.metadata.retire(organizationId, artifact.id, artifact.key)) retired += 1; else failed += 1; }
      catch { failed += 1; }
    }
    return { claimed, retired, failed };
  }
  /** Expiry claims hide objects before external deletion. Failed deletes remain
   * cleaning rows and are retried by recoverIncomplete after its grace period. */
  async expireReady(organizationId: string, before: Date, limit = 25): Promise<{ claimed: number; retired: number; failed: number }> {
    validateRecovery(before, limit);
    if (!organizationId) throw new Error("Artifact owner is required for retention");
    const candidates = await this.metadata.listExpiredReady(organizationId, before, limit);
    let claimed = 0; let retired = 0; let failed = 0;
    for (const artifact of candidates) {
      if (!await this.metadata.claimExpiredReady(organizationId, artifact.id, artifact.key, before)) continue;
      claimed += 1;
      try { await this.bucket.delete(artifact.key); }
      catch { failed += 1; continue; }
      try { if (await this.metadata.retire(organizationId, artifact.id, artifact.key)) retired += 1; else failed += 1; }
      catch { failed += 1; }
    }
    return { claimed, retired, failed };
  }
}
