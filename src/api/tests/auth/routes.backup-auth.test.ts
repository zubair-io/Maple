/**
 * Route-gating regression test (#853).
 *
 * The six PhotoKit-backup routes were mounted OUTSIDE the `requireAuth`
 * sub-app in `src/index.ts`, so they accepted uploads/deletes with no bearer
 * (a remote unauthenticated file-write surface — see #854). This asserts every
 * backup route rejects an unauthenticated request with 401.
 *
 * Mongo-free by design: with no `Authorization` header, `requireAuth`
 * short-circuits to 401 before the handler (and before any DB access). The
 * invalid `libraryId` guarantees a fast, non-Mongo failure in the pre-fix
 * (ungated) state too, so the test never blocks on a DB connection.
 */
import { describe, it, expect } from 'bun:test';
import { buildApp } from '../../src/index.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

const app = buildApp({ stageNames: [] });

// Invalid ObjectId: pre-fix the handler 400s on it before touching Mongo;
// post-fix requireAuth 401s before the handler ever parses params.
const LIB = 'x';
const BACKUP_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['POST', `/api/libraries/${LIB}/backup/ingest`],
  ['GET', `/api/libraries/${LIB}/backup/state`],
  ['POST', `/api/libraries/${LIB}/backup/exists`],
  ['POST', `/api/libraries/${LIB}/backup/sidecar`],
  ['POST', `/api/libraries/${LIB}/backup/rendered`],
  ['POST', `/api/libraries/${LIB}/backup/notify-deleted`],
];

describe('backup routes require authentication (#853)', () => {
  for (const [method, path] of BACKUP_ROUTES) {
    it(`${method} ${path} rejects an unauthenticated request with 401`, async () => {
      const res = await app.handle(new Request(`http://localhost${path}`, { method }));
      expect(res.status).toBe(401);
    });
  }
});
