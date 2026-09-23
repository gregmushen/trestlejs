import { neon, neonConfig, Pool } from "@neondatabase/serverless";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";

export type SqlRow = Record<string, unknown>;

/**
 * Executes compiled statements on either driver. `atomic` runs a fixed list of
 * statements in one transaction, which lets a mutation, its audit record, and
 * its outbox event commit together on stateless HTTP drivers as well.
 */
export interface SqlRunner {
  query<Row extends SqlRow = SqlRow>(statement: SQL): Promise<Row[]>;
  atomic(statements: readonly SQL[]): Promise<SqlRow[][]>;
}

const dialect = new PgDialect();

export function createSqlRunner(connectionString: string, driver: "neon-http" | "neon-serverless" | "postgres-js" = "neon-http"): SqlRunner {
  if (driver === "neon-serverless") return neonServerlessRunner(connectionString);
  if (driver === "neon-http") {
    const client = neon(connectionString);
    return {
      query: async <Row extends SqlRow>(statement: SQL) => {
        const compiled = dialect.sqlToQuery(statement);
        return await client.query(compiled.sql, compiled.params as unknown[]) as Row[];
      },
      atomic: async (statements) => await client.transaction(statements.map((statement) => {
        const compiled = dialect.sqlToQuery(statement);
        return client.query(compiled.sql, compiled.params as unknown[]);
      })) as SqlRow[][],
    };
  }
  // Workers cannot share sockets across requests, so each operation opens one
  // connection and closes it immediately instead of leaving idle clients behind.
  const withClient = async <T>(work: (client: postgres.Sql) => Promise<T>): Promise<T> => {
    const client = postgres(connectionString, { max: 1, idle_timeout: 1, prepare: false });
    try { return await work(client); } finally { await client.end({ timeout: 1 }); }
  };
  const run = async (target: postgres.Sql | postgres.TransactionSql, statement: SQL): Promise<SqlRow[]> => {
    const compiled = dialect.sqlToQuery(statement);
    return [...await target.unsafe(compiled.sql, compiled.params as postgres.ParameterOrJSON<never>[])] as SqlRow[];
  };
  return {
    query: async <Row extends SqlRow>(statement: SQL) => await withClient(async (client) => await run(client, statement) as Row[]),
    atomic: async (statements) => await withClient(async (client) => await client.begin(async (transaction) => {
      const results: SqlRow[][] = [];
      for (const statement of statements) results.push(await run(transaction, statement));
      return results;
    }) as SqlRow[][]),
  };
}

/** WebSocket transport: one short-lived pooled connection per operation, as Workers require. */
function neonServerlessRunner(connectionString: string): SqlRunner {
  const withPool = async <T>(work: (pool: Pool) => Promise<T>): Promise<T> => {
    if (typeof WebSocket === "undefined") throw new Error("Neon serverless transactions require a WebSocket implementation");
    neonConfig.webSocketConstructor = WebSocket;
    const pool = new Pool({ connectionString, max: 1, idleTimeoutMillis: 1_000 });
    try { return await work(pool); } finally { await pool.end(); }
  };
  const compile = (statement: SQL) => { const compiled = dialect.sqlToQuery(statement); return [compiled.sql, compiled.params as unknown[]] as const; };
  return {
    query: async <Row extends SqlRow>(statement: SQL) => await withPool(async (pool) => (await pool.query(...compile(statement))).rows as Row[]),
    atomic: async (statements) => await withPool(async (pool) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const results: SqlRow[][] = [];
        for (const statement of statements) results.push((await client.query(...compile(statement))).rows as SqlRow[]);
        await client.query("commit");
        return results;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }),
  };
}
