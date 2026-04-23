/**
 * /api/health route.
 *
 * Returns server liveness + optional MongoDB status.
 */

import { Elysia } from "elysia";
import { isDbConnected } from "../db/client.ts";

const VERSION = "0.1.0";

export const healthRoutes = new Elysia().get("/api/health", () => ({
  ok: true,
  product: "maple-self-hosted",
  version: VERSION,
  db_connected: isDbConnected(),
  timestamp: new Date().toISOString(),
}));
