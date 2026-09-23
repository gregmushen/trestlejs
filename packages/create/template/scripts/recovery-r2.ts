import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type ReadyArtifactReference = { id: string; organizationId: string; key: string; contentType: string; size: number };
export type ArtifactObjectMetadata = { size: number | undefined; contentType: string | undefined; metadata: Record<string, string> | undefined };
export type ArtifactVerificationResult = { expected: number; checked: number; missing: number; mismatched: number; unavailable: number };

/** A null result is a confirmed missing object; exceptions are provider
 * unavailability, never evidence of absence. The caller must scan every page. */
export async function verifyArtifactObjects(
  expected: number,
  page: (afterId: string, limit: number) => Promise<ReadyArtifactReference[]>,
  head: (key: string) => Promise<ArtifactObjectMetadata | null>,
): Promise<ArtifactVerificationResult> {
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("Invalid ready artifact count");
  const result: ArtifactVerificationResult = { expected, checked: 0, missing: 0, mismatched: 0, unavailable: 0 };
  let afterId = "";
  while (true) {
    const references = await page(afterId, 100);
    if (references.length > 100 || references.some((reference, index) => !reference.id || reference.id <= (index === 0 ? afterId : references[index - 1]!.id))) {
      throw new Error("Ready artifact pagination is invalid");
    }
    if (references.length === 0) break;
    for (const reference of references) {
      if (!reference.organizationId || !reference.key || !reference.contentType || !Number.isSafeInteger(reference.size) || reference.size < 0) {
        throw new Error("Ready artifact metadata is invalid");
      }
      result.checked += 1;
      if (result.checked > expected) throw new Error("Ready artifact count changed during verification");
      try {
        const object = await head(reference.key);
        if (!object) { result.missing += 1; continue; }
        const metadata = Object.fromEntries(Object.entries(object.metadata ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
        if (object.size !== reference.size || object.contentType !== reference.contentType
          || metadata.organizationid !== reference.organizationId || metadata.artifactid !== reference.id) result.mismatched += 1;
      } catch { result.unavailable += 1; }
    }
    afterId = references.at(-1)!.id;
  }
  if (result.checked !== expected) throw new Error("Ready artifact count changed during verification");
  return result;
}

export function createR2RecoveryHead(input: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }): {
  head: (key: string) => Promise<ArtifactObjectMetadata | null>;
  close: () => void;
} {
  if (!/^[a-f0-9]{32}$/iu.test(input.accountId) || !input.accessKeyId || !input.secretAccessKey || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(input.bucket)) {
    throw new Error("R2 recovery credentials, account, or bucket are missing or invalid");
  }
  const client = new S3Client({ region: "auto", endpoint: `https://${input.accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey }, maxAttempts: 2 });
  return {
    async head(key) {
      try {
        const object = await client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: key }));
        return { size: object.ContentLength, contentType: object.ContentType, metadata: object.Metadata };
      } catch (error) {
        const problem = error as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (problem.$metadata?.httpStatusCode === 404 || problem.name === "NotFound" || problem.name === "NoSuchKey") return null;
        // Never propagate an SDK error into recovery evidence: it can include
        // signed request details, bucket names, and object keys.
        throw new Error("R2 HEAD unavailable");
      }
    },
    close: () => client.destroy(),
  };
}
