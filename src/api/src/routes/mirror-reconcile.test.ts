/**
 * "Reconcile now" as a job row: the route queues one reconcile for the worker
 * tier and answers with its phase, and the status route reads the latest
 * reconcile row whichever process wrote it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import {
  createLiveTestDatabase,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { newObjectIdHex } from '../db/object-id.ts';
import { clearMirrorRoots, setMirrorRoots } from '../fs/mirror-registry.ts';
import { idleReconcile } from '../workers/mirror/reconcile-progress.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { mirrorRoutes } from './mirror.ts';

let live: LiveTestDatabase;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  clearMirrorRoots();
});

afterEach(() => {
  clearMirrorRoots();
  live.close();
});

const app = new Elysia().use(fakeAuth()).use(mirrorRoutes);

const call = async (url: string, method = 'GET') =>
  (await app.handle(new Request(`http://localhost${url}`, { method }))).json();

const reconcile = () => call('/api/mirror/reconcile', 'POST');
const status = () => call('/api/mirror/status');

interface WrittenRow {
  status: string;
  ledger?: unknown;
  result?: unknown;
  error?: string;
  createdAt?: string;
}

/** A reconcile row as the worker process leaves it. */
function writeReconcileRow(row: WrittenRow): void {
  const createdAt = row.createdAt ?? '2026-11-01T10:00:00.000Z';
  run(
    live.db,
    `INSERT INTO jobs (id, kind, status, created_at, updated_at, params, ledger, result, error)
     VALUES (?, 'mirror_reconcile', ?, ?, '2026-11-01T10:05:00.000Z', '{}', ?, ?, ?)`,
    newObjectIdHex(),
    row.status,
    createdAt,
    row.ledger === undefined ? null : JSON.stringify(row.ledger),
    row.result === undefined ? null : JSON.stringify(row.result),
    row.error ?? null,
  );
}

const jobCount = () =>
  (
    live.db.query(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'mirror_reconcile'`).get() as {
      n: number;
    }
  ).n;

describe('POST /api/mirror/reconcile', () => {
  it('refuses with no mirror configured, and queues nothing', async () => {
    expect(await reconcile()).toEqual({
      started: false,
      phase: 'idle',
      reason: 'no mirror configured',
    });
    expect(jobCount()).toBe(0);
  });

  it('queues one reconcile, and answers a second press with the running one', async () => {
    setMirrorRoots({ '/srv/primary': ['/srv/mirror'] });

    expect(await reconcile()).toEqual({ started: true, phase: 'scanning' });
    expect(await reconcile()).toEqual({ started: false, phase: 'scanning' });
    expect(jobCount()).toBe(1);
  });

  it('answers with the phase of a reconcile the worker is already copying', async () => {
    setMirrorRoots({ '/srv/primary': ['/srv/mirror'] });
    writeReconcileRow({
      status: 'running',
      ledger: { reconcile: { ...idleReconcile(), phase: 'copying' } },
    });

    expect(await reconcile()).toEqual({ started: false, phase: 'copying' });
  });
});

describe('GET /api/mirror/status', () => {
  it('is idle before any reconcile', async () => {
    const body = await status();
    expect(body.reconcile).toEqual(idleReconcile());
    expect(body.queue).toEqual({ pending: 0, dead: 0 });
  });

  it("reports a running reconcile's live progress from its row", async () => {
    const snapshot = {
      ...idleReconcile(),
      phase: 'copying',
      scan: { scanned: 10, toCopy: 4, upToDate: 6, errors: 0 },
      copy: { total: 4, copied: 1, remaining: 3, errors: 0 },
      currentPath: '/srv/primary/b.dng',
      startedAt: '2026-11-01T10:00:01.000Z',
      copiedLog: ['/srv/primary/a.dng'],
    };
    writeReconcileRow({ status: 'running', ledger: { reconcile: snapshot } });

    expect((await status()).reconcile).toEqual(snapshot);
  });

  it('reports a queued reconcile as starting its scan', async () => {
    writeReconcileRow({ status: 'queued' });

    expect((await status()).reconcile).toMatchObject({
      phase: 'scanning',
      startedAt: '2026-11-01T10:00:00.000Z',
    });
  });

  it('reports a failed reconcile as idle, with its error at the end of the log', async () => {
    writeReconcileRow({
      status: 'failed',
      error: 'mirror disk unplugged',
      ledger: { reconcile: { ...idleReconcile(), phase: 'copying', currentPath: '/x' } },
    });

    expect((await status()).reconcile).toMatchObject({
      phase: 'idle',
      currentPath: null,
      finishedAt: '2026-11-01T10:05:00.000Z',
      errorLog: [
        { path: '(reconcile)', error: 'mirror disk unplugged', at: '2026-11-01T10:05:00.000Z' },
      ],
    });
  });

  it('reads the latest reconcile when there have been several', async () => {
    writeReconcileRow({
      status: 'done',
      createdAt: '2026-10-01T00:00:00.000Z',
      result: { reconcile: { ...idleReconcile(), copiedLog: ['/old.dng'] } },
    });
    writeReconcileRow({
      status: 'done',
      createdAt: '2026-11-01T00:00:00.000Z',
      result: { reconcile: { ...idleReconcile(), copiedLog: ['/new.dng'] } },
    });

    expect((await status()).reconcile.copiedLog).toEqual(['/new.dng']);
  });
});
