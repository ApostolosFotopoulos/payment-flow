import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { config } from "../config";
import * as schema from "./schema";

export type PoolOptions = {
  /** Overrides the connection string from the environment (used by tests). */
  connectionString?: string;
  max?: number;
};

/**
 * Server-side on purpose: PostgreSQL cancels the query and frees the slot, whereas
 * a client-side timer would leave the query running and still holding its slot.
 *
 * `connectionTimeoutMillis` covers the other half: how long a request may wait for
 * a free slot. `pg` defaults it to 0 (wait forever), so without it a saturated pool
 * hangs requests rather than failing them.
 */
export function createPool(options: PoolOptions = {}): Pool {
  return new Pool({
    connectionString: options.connectionString ?? config.databaseUrl,
    max: options.max ?? config.databasePoolMax,
    statement_timeout: config.databaseStatementTimeoutMs,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
  });
}

export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export { schema };
