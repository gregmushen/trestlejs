import { eq, sql } from "drizzle-orm";

import { authenticationAssurance, type SessionAssuranceLevel, type SessionAssuranceMethod } from "./assurance-schema.js";
import type { Database } from "./index.js";

export type SessionAssurance = Readonly<{ sessionId: string; userId: string; level: SessionAssuranceLevel; method: SessionAssuranceMethod; verifiedAt: Date }>;

/** Records how a session was authenticated; a later verification on the same session replaces it. */
export async function recordAssurance(database: Pick<Database, "insert">, input: Readonly<{ sessionId: string; userId: string; level: SessionAssuranceLevel; method: SessionAssuranceMethod }>): Promise<void> {
  await database.insert(authenticationAssurance).values({ ...input, verifiedAt: new Date() })
    .onConflictDoUpdate({ target: authenticationAssurance.sessionId, set: { level: input.level, method: input.method, verifiedAt: sql`now()` } });
}

export async function sessionAssurance(database: Pick<Database, "select">, sessionId: string): Promise<SessionAssurance | null> {
  const [row] = await database.select().from(authenticationAssurance).where(eq(authenticationAssurance.sessionId, sessionId)).limit(1);
  // The CHECK constraints guarantee the stored values are members of these unions.
  return row ? { ...row, level: row.level as SessionAssuranceLevel, method: row.method as SessionAssuranceMethod } : null;
}
