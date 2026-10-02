import { createApp } from "./app";
import { config } from "./config";
import { createDb, createPool } from "./db/client";

async function main(): Promise<void> {
  const pool = createPool();
  const db = createDb(pool);
  const app = createApp(db);

  const server = app.listen(config.port, () => {
    console.log(`payment-flow listening on :${config.port} (${config.env})`);
  });

  const shutdown = (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("failed to start:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
