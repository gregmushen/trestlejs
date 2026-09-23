import type { StreamDefinition, StreamVersionRecord } from "@__TRESTLE_PROJECT_NAME__/domain";
import type { SqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";
import { sql } from "drizzle-orm";

/** Active stream versions for sends, plus archived stream types so sends to them fail visibly. */
export async function loadNotificationStreams(runner: SqlRunner): Promise<{ active: StreamVersionRecord[]; archived: string[] }> {
  const rows = await runner.query(sql`select s.type, s.name, s.description, s.archived_at, v.version, v.state, v.definition
    from notification_stream s left join notification_stream_version v on v.type = s.type and v.state = 'active'`);
  return {
    active: rows.filter((row) => !row.archived_at && row.version !== null && row.version !== undefined).map((row) => ({
      type: String(row.type), name: String(row.name), description: String(row.description ?? ""), version: Number(row.version), state: "active" as const,
      definition: (typeof row.definition === "string" ? JSON.parse(row.definition) : row.definition) as StreamDefinition,
    })),
    archived: rows.filter((row) => row.archived_at).map((row) => String(row.type)),
  };
}
