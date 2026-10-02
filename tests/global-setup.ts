import { Client } from "pg";

import { runMigrations } from "../src/db/migrate";

/**
 * Fails fast with a helpful message when PostgreSQL is not reachable, and makes
 * sure the test database has the latest schema before any suite runs.
 */
export default async function globalSetup(): Promise<void> {
  const connectionString = process.env.TEST_DATABASE_URL;

  try {
    const client = new Client({ connectionString });
    await client.connect();
    await client.end();
  } catch (error) {
    throw new Error(
      `Cannot connect to TEST_DATABASE_URL (${connectionString}).\n` +
        `Start PostgreSQL first:  docker compose up -d db\n` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await runMigrations(connectionString);
}
