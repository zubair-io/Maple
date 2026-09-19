/**
 * /api/health route.
 *
 * Returns server liveness + optional MongoDB status.
 */

import { Elysia } from 'elysia';
import { isSqliteOpen } from '../db/sqlite/index.ts';

const VERSION = '0.1.0';

export const healthRoutes = new Elysia().get('/api/health', () => ({
  ok: true,
  product: 'maple',
  version: VERSION,
  db_connected: isSqliteOpen(),
  timestamp: new Date().toISOString(),
}));
