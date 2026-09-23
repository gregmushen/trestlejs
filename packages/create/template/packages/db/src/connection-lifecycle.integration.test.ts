import postgres from "postgres";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createDatabase } from "./index.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const monitor = databaseUrl ? postgres(databaseUrl, { max: 1, prepare: false }) : undefined;

suite("local PostgreSQL connection lifecycle", () => {
  afterAll(async () => { await monitor!.end(); });

  it("retires per-request sockets promptly without caching I/O across Worker requests", async () => {
    const applicationName = `trestle-idle-${crypto.randomUUID()}`;
    const url = new URL(databaseUrl!);
    url.searchParams.set("application_name", applicationName);
    const first = createDatabase(url.toString(), "postgres-js");
    expect(createDatabase(url.toString(), "postgres-js")).not.toBe(first);
    await Promise.all(Array.from({ length: 32 }, () => createDatabase(url.toString(), "postgres-js").execute(sql`select 1`)));
    let active = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const [row] = await monitor!<{ count: number }[]>`select count(*)::int as count from pg_stat_activity where application_name = ${applicationName}`;
      active = row?.count ?? 0;
      if (active === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(active).toBe(0);
  });
});
