import express, { type Express } from "express";

import type { Db } from "./db/client";
import { errorHandler, notFoundHandler } from "./http/error-handler";
import { checkoutRouter } from "./http/routes/checkout";
import { ordersRouter } from "./http/routes/orders";
import { webhooksRouter } from "./http/routes/webhooks";
import { asyncRoute } from "./http/validation";

export function createApp(db: Db): Express {
  const app = express();

  app.disable("x-powered-by");
  // A malformed JSON body must not reach a handler: express.json throws a
  // SyntaxError, which the error handler turns into a 400.
  app.use(express.json({ limit: "64kb" }));

  app.get(
    "/health",
    asyncRoute(async (_req, res) => {
      await db.execute("SELECT 1");
      res.status(200).json({ status: "ok", database: "reachable" });
    }),
  );

  app.use(checkoutRouter(db));
  app.use(ordersRouter(db));
  app.use(webhooksRouter(db));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
