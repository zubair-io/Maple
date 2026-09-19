/**
 * Route-integration test: /api/change-log-gc (#3741) and the stale-cursor 409
 * a retention sweep leaves behind.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787). The journal's cursor is allocated by the insert
 * itself — `asset_changes.cursor` is an `INTEGER PRIMARY KEY`, so the row and
 * its cursor land in one statement — which is why these tests write rows with
 * `recordAssetChange` and then age them, rather than allocating a cursor and
 * inserting a document around it the way the MongoDB version had to.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from '../db/object-id.ts';
import { changeLogGcRoutes } from './change-log-gc.ts';
import { changesRoutes } from './changes.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { recordAssetChange } from '../db/repos/changes.repo.ts';
import { runChangeLogGcOnce } from '../workers/change-log-gc.ts';
import { saveChangeLogGcConfig } from '../workers/change-log-gc-config.repo.ts';

const DAY_MS = 86_400_000;

let live: LiveTestDatabase;
let app: Pick<Elysia, 'handle'>;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  app = new Elysia().use(fakeAuth()).use(changeLogGcRoutes).use(changesRoutes);
});

afterEach(() => {
  live.close();
});

/** Write one journal row and return its cursor. */
async function writeChange(absPath: string): Promise<number> {
  return await recordAssetChange(undefined, {
    kind: 'update',
    asset_id: new ObjectId(),
    folder_id: null,
    abs_path: absPath,
  });
}

/** Backdate a row so a retention sweep considers it expired. */
function ageChange(cursor: number, at: Date): void {
  live.db.run(`UPDATE asset_changes SET at = ? WHERE cursor = ?`, [at.toISOString(), cursor]);
}

describe('/api/change-log-gc', () => {
  it('reports the defaults before anything has been configured', async () => {
    const res = await app.handle(new Request('http://localhost/api/change-log-gc/status'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.enabled).toBe(true);
    expect(body.config.retention_days).toBe(30);
    expect(body.rows).toBe(0);
    expect(body.pruned_through).toBe(0);
  });

  it('counts the rows actually in the journal', async () => {
    await writeChange('/lib/a.dng');
    await writeChange('/lib/b.dng');
    const res = await app.handle(new Request('http://localhost/api/change-log-gc/status'));
    expect((await res.json()).rows).toBe(2);
  });

  it('persists a retention-window edit and reads it straight back', async () => {
    const put = await app.handle(
      new Request('http://localhost/api/change-log-gc/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retention_days: 7, enabled: false }),
      }),
    );
    expect(put.status).toBe(200);
    expect((await put.json()).config.retention_days).toBe(7);

    const status = await app.handle(new Request('http://localhost/api/change-log-gc/status'));
    const body = await status.json();
    expect(body.config.retention_days).toBe(7);
    expect(body.config.enabled).toBe(false);
  });

  it('rejects a window outside the accepted range', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/change-log-gc/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retention_days: 0 }),
      }),
    );
    expect(res.status).toBe(422);
  });
});

describe('GET /api/changes after a sweep', () => {
  it('answers 409 to a cursor the sweep pruned past, and serves a fresh one', async () => {
    await saveChangeLogGcConfig({ retention_days: 30 });

    const agedTime = new Date(Date.now() - 90 * DAY_MS);
    const stale: number[] = [];
    for (let i = 0; i < 3; i++) {
      const cursor = await writeChange(`/lib/old-${i}.dng`);
      ageChange(cursor, agedTime);
      stale.push(cursor);
    }
    const fresh = await writeChange('/lib/new.dng');

    const summary = await runChangeLogGcOnce({ pauseMs: 0 });
    expect(summary.deleted).toBe(3);

    // A client parked on a cursor from before the sweep is told to start over.
    const stalest = stale[0]! - 1;
    const staleRes = await app.handle(new Request(`http://localhost/api/changes?since=${stalest}`));
    expect(staleRes.status).toBe(409);
    const staleBody = await staleRes.json();
    expect(staleBody.error).toMatch(/too old/i);
    expect(staleBody.current).toBeGreaterThanOrEqual(fresh);

    // A client already past the floor is served normally.
    const okRes = await app.handle(
      new Request(`http://localhost/api/changes?since=${summary.prunedThrough}`),
    );
    expect(okRes.status).toBe(200);
    const okBody = await okRes.json();
    expect(okBody.changes.map((c: { cursor: number }) => c.cursor)).toEqual([fresh]);
  });

  it('serves every cursor normally while nothing has been pruned', async () => {
    const cursor = await writeChange('/lib/a.dng');
    const res = await app.handle(new Request('http://localhost/api/changes?since=0'));
    expect(res.status).toBe(200);
    expect((await res.json()).changes.map((c: { cursor: number }) => c.cursor)).toEqual([cursor]);
  });
});
