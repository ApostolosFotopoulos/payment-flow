import { existsSync } from "node:fs";

function loadDotEnv(): void {
  // Node >= 20.6 ships a dependency-free .env loader. Docker/compose sets real
  // env vars, so this is only a convenience for local runs.
  if (!existsSync(".env")) return;
  try {
    process.loadEnvFile(".env");
  } catch {
    // ignore malformed/unreadable .env - real env vars still win
  }
}

loadDotEnv();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

const env = process.env.NODE_ENV ?? "development";

const config = {
  env,
  isTest: env === "test",
  port: positiveInt("PORT", 3000),
  /** Used by the service and by `npm run db:migrate`. */
  databaseUrl: required("DATABASE_URL", "postgres://payment:payment@localhost:5432/payment_flow"),
  /** Tests truncate this database; they never touch `databaseUrl`. */
  testDatabaseUrl: required(
    "TEST_DATABASE_URL",
    "postgres://payment:payment@localhost:5432/payment_flow_test",
  ),
  databasePoolMax: positiveInt("DATABASE_POOL_MAX", 10),
  /** Longest a single statement may run before PostgreSQL cancels it. */
  databaseStatementTimeoutMs: positiveInt("DATABASE_STATEMENT_TIMEOUT_MS", 5_000),
  /**
   * Longest a request waits for a free connection. `pg` defaults this to 0, which
   * means wait forever, so a saturated pool would hang requests instead of failing.
   */
  databaseConnectionTimeoutMs: positiveInt("DATABASE_CONNECTION_TIMEOUT_MS", 5_000),
};

export type Config = typeof config;
export { config };
