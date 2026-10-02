import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { config } from "../config";
import { AppError } from "./errors";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: "route_not_found", message: `No route for ${req.method} ${req.path}` },
  });
}

/** Single place where every failure becomes an HTTP response. */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json(error.toBody());
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      error: { code: "invalid_request", message: "Request body is invalid" },
    });
    return;
  }

  // express.json() rejects malformed JSON with a SyntaxError carrying a status.
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({
      error: { code: "invalid_json", message: "Request body is not valid JSON" },
    });
    return;
  }

  // Unexpected failures (including database errors) are never acknowledged with
  // a 2xx: the provider or the client must retry, and nothing was committed.
  const message = error instanceof Error ? error.message : String(error);
  console.error("unhandled error:", message, error instanceof Error ? error.stack : "");
  res.status(500).json({
    error: {
      code: "internal_error",
      message: "Internal server error",
      ...(config.isTest ? { detail: message } : {}),
    },
  });
}
