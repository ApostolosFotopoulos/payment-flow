import path from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDb, createPool } from "./client";

/**
 * Applies every SQL file in ./drizzle that has not been applied yet.
 * Drizzle keeps its own ledger table, so this is safe to run repeatedly
 * (it is also what `docker compose up` runs before starting the server).
 */
export async function runMigrations(connectionString?: string): Promise<void> {
  const pool = createPool({ connectionString });
  try {
    await migrate(createDb(pool), {
      migrationsFolder: path.resolve(process.cwd(), "drizzle"),
    });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log("migrations applied");
      return undefined;
    })
    .catch((error: unknown) => {
      console.error("migration failed:", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
