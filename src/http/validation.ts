import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny, z } from "zod";

import { AppError } from "./errors";

/** Parses any input with a zod schema, converting failures into a 400 AppError. */
export function parseWith<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(400, "invalid_request", "Request is invalid", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

/**
 * Parses and validates a request body. Unknown properties are rejected so that a
 * typo in the checkout payload cannot silently create a different order than the
 * caller thinks (and so retries compare like with like).
 */
export function parseBody<S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  return parseWith(schema, req.body);
}

/** Wraps an async handler so rejected promises reach the error middleware. */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
