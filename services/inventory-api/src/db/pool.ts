import pg from "pg";

export type Tx = pg.PoolClient;

export function createPool(connectionString: string, max = 20): pg.Pool {
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
}

/** Runs fn inside a READ COMMITTED transaction; rolls back on any thrown error. */
export async function withTransaction<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
